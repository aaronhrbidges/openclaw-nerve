/**
 * Kanban API Routes
 *
 * GET    /api/kanban/tasks          — List tasks (with filters + pagination)
 * POST   /api/kanban/tasks          — Create a task
 * PATCH  /api/kanban/tasks/:id      — Update a task (CAS versioned)
 * DELETE /api/kanban/tasks/:id      — Delete a task
 * POST   /api/kanban/tasks/:id/reorder — Reorder / move a task
 * GET    /api/kanban/config         — Get board config
 * PUT    /api/kanban/config         — Update board config
 * @module
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { rateLimitGeneral } from '../middleware/rate-limit.js';
import {
  getKanbanStore,
  VersionConflictError,
  TaskNotFoundError,
  InvalidTransitionError,
  ProposalNotFoundError,
  ProposalAlreadyResolvedError,
} from '../lib/kanban-store.js';
import { invokeGatewayTool } from '../lib/gateway-client.js';
import { parseKanbanMarkers, stripKanbanMarkers } from '../lib/parseMarkers.js';
import { PHASE_GATE_STEP, PHASE_ACTIVE_LABEL, SDD_PHASES } from '../../src/features/kanban/lib/sdd.js';
import type {
  TaskStatus,
  TaskPriority,
  TaskActor,
  ProposalStatus,
  SddPhase,
  PhaseSession,
  SddStatusPhase,
} from '../lib/kanban-store.js';

const app = new Hono();

// ── Session completion poller ────────────────────────────────────────

/** Parse gateway tool response — unwraps content[0].text JSON wrapper if present. */
function parseGatewayResponse(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    // Gateway wraps tool results in { content: [{ type: "text", text: "..." }] }
    const content = r.content as Array<Record<string, unknown>> | undefined;
    if (content?.[0]?.text && typeof content[0].text === 'string') {
      try { return JSON.parse(content[0].text); } catch { /* fall through */ }
    }
    // Also check details (some tools put parsed data there)
    if (r.details && typeof r.details === 'object') return r.details as Record<string, unknown>;
    return r;
  }
  return {};
}

// ── Active poll timer tracking (for graceful shutdown) ───────────────

const activePollTimers = new Set<ReturnType<typeof setTimeout>>();

function trackTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const id = setTimeout(() => {
    activePollTimers.delete(id);
    fn();
  }, ms);
  activePollTimers.add(id);
  return id;
}

/** Cancel all active poll timers (call on shutdown). */
export function cleanupKanbanPollers(): void {
  for (const t of activePollTimers) clearTimeout(t);
  activePollTimers.clear();
}

/** Re-attach pollers for any tasks with run.status === 'running' on startup. */
export async function rehydrateKanbanPollers(): Promise<void> {
  try {
    const store = getKanbanStore();
    const { items } = await store.listTasks({ limit: 200 });
    const running = items.filter((t) => {
      return t.status === 'in-progress' && t.run?.status === 'running' && t.run?.sessionKey;
    });
    for (const task of running) {
      // The poller matches by spawn label, which is kb-{id} (no timestamp).
      // run.sessionKey has a timestamp suffix, so strip it for the label.
      const label = `kb-${task.id}`;
      console.log(`[kanban] Rehydrating poller for task ${task.id} (label: ${label})`);
      pollSessionCompletion(store, task.id, label);
    }
    if (running.length > 0) {
      console.log(`[kanban] Rehydrated ${running.length} poller(s)`);
    }
  } catch (err) {
    console.error('[kanban] Failed to rehydrate pollers:', err);
  }
}

/** Poll gateway subagents for a kanban run label until it finishes, then complete the run. */
function pollSessionCompletion(
  store: ReturnType<typeof getKanbanStore>,
  taskId: string,
  label: string,
  intervalMs = 5_000,
  maxAttempts = 1500, // ~125 minutes (matches 120min agent timeout with headroom)
): void {
  let attempts = 0;

  const poll = async () => {
    attempts++;
    if (attempts > maxAttempts) {
      console.warn(`[kanban] Polling timed out for task ${taskId} (label: ${label})`);
      await store.completeRun(taskId, undefined, 'Run timed out (polling limit reached)').catch(() => {});
      return;
    }

    try {
      // Check if task is still in-progress before polling
      const task = await store.getTask(taskId).catch(() => null);
      if (!task || task.status !== 'in-progress') return; // task was moved/aborted, stop

      const raw = await invokeGatewayTool('subagents', { action: 'list', recentMinutes: 120 });
      const parsed = parseGatewayResponse(raw);

      // subagents list returns { active: [...], recent: [...] }
      const active = (parsed.active ?? []) as Array<Record<string, unknown>>;
      const recent = (parsed.recent ?? []) as Array<Record<string, unknown>>;
      const all = [...active, ...recent];

      // Labels are now kb-{slug}-{timestamp} (max ~47 chars), well under
      // the gateway's ~50 char truncation limit. Exact match only.
      const match = all.find((s) => String(s.label ?? '') === label);

      if (!match) {
        // Not found yet -- may not have registered, keep trying
        trackTimeout(poll, intervalMs);
        return;
      }

      const status = match.status as string;

      if (status === 'done') {
        // Fetch session history to get the result text
        let resultText = 'Completed (no result text)';
        try {
          const histRaw = await invokeGatewayTool('sessions_history', {
            sessionKey: match.sessionKey,
            limit: 3,
          });
          const histParsed = parseGatewayResponse(histRaw);
          const messages = (histParsed.messages ?? []) as Array<Record<string, unknown>>;
          const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
          if (lastAssistant) {
            const content = lastAssistant.content;
            if (typeof content === 'string') {
              resultText = content;
            } else if (Array.isArray(content)) {
              const textPart = (content as Array<Record<string, unknown>>).find((p) => p.type === 'text');
              if (textPart && typeof textPart.text === 'string') resultText = textPart.text;
            }
          }
        } catch (err) {
          console.warn(`[kanban] Could not fetch history for ${label}:`, err);
        }

        // Parse kanban markers from the result and auto-apply them.
        // Agent-spawned sessions are authorized executors — their kanban
        // updates should not require proposal confirmation.
        const markers = parseKanbanMarkers(resultText);
        let markerApplied = false;
        for (const marker of markers) {
          try {
            if (marker.type === 'update' && marker.payload.id === taskId) {
              // Direct update for this task — apply immediately
              const task = await store.getTask(taskId);
              const patch: Record<string, unknown> = {};
              if (marker.payload.status) patch.status = marker.payload.status;
              if (marker.payload.result) patch.result = marker.payload.result;
              if (marker.payload.labels) patch.labels = marker.payload.labels;
              await store.updateTask(taskId, task.version, patch);
              markerApplied = true;
              console.log(`[kanban] Auto-applied marker for task ${taskId}: status=${marker.payload.status}`);

              // Update structured sddStatus from marker fields if present
              const p = marker.payload;
              if (p.sddPhase) {
                await store.setSddPhase(taskId, p.sddPhase as any, p.sddSummary as string || undefined);
              }
              if (p.sddGate) {
                await store.setSddGate(taskId, p.sddGate as string, p.sddLink as string || undefined, p.sddSummary as string || undefined);
              }
            } else {
              // Different task or create — use proposal system
              await store.createProposal({
                type: marker.type,
                payload: marker.payload,
                sourceSessionKey: label,
                proposedBy: `agent:${label}`,
              });
            }
          } catch (err) {
            console.warn(`[kanban] Failed to apply marker for task ${taskId}:`, err);
          }
        }

        // If a marker already set the task status/result, just complete the run
        // without overwriting the result with raw agent text.
        console.log(`[kanban] Run completed for task ${taskId} (label: ${label})`);
        if (markerApplied) {
          // Marker already moved the task (e.g. to needs-input). Just mark run as done.
          await store.completeRun(taskId).catch((err) => {
            console.error(`[kanban] Failed to complete run for task ${taskId}:`, err);
          });
        } else {
          // No marker applied — use the stripped text as fallback result
          const cleanResult = markers.length > 0 ? stripKanbanMarkers(resultText) : resultText;
          await store.completeRun(taskId, cleanResult).catch((err) => {
            console.error(`[kanban] Failed to complete run for task ${taskId}:`, err);
          });
        }
        return;
      }

      if (status === 'error' || status === 'failed') {
        const errorMsg = (match.error as string) || 'Agent session failed';
        await store.completeRun(taskId, undefined, errorMsg).catch(() => {});
        return;
      }

      if (status === 'running') {
        trackTimeout(poll, intervalMs);
        return;
      }

      // Unknown status -- keep polling
      trackTimeout(poll, intervalMs);
    } catch (err) {
      console.error(`[kanban] Poll error for task ${taskId}:`, err);
      trackTimeout(poll, intervalMs); // retry on transient errors
    }
  };

  // Start after a brief delay to let the session register
  trackTimeout(poll, 3_000);
}

// ── Zod schemas ──────────────────────────────────────────────────────

const taskStatusSchema = z.enum(['backlog', 'todo', 'in-progress', 'needs-input', 'blocked', 'review', 'done', 'cancelled']);
const taskPrioritySchema = z.enum(['critical', 'high', 'normal', 'low']);
const taskActorSchema = z.union([
  z.literal('operator'),
  z.string().regex(/^agent:.+$/),
]) as z.ZodType<TaskActor>;
const thinkingSchema = z.enum(['off', 'low', 'medium', 'high']);

const sddPhaseSchema = z.enum(['specify', 'plan', 'implement']);
const sddStatusPhaseSchema = z.enum(['specify', 'plan', 'implement', 'review', 'done']);

const sddEventSchema = z.object({
  at: z.number(),
  phase: z.string(),
  gate: z.string().optional(),
  action: z.enum(['started', 'gate-reached', 'approved', 'rejected', 'error', 'retry', 'completed']),
  summary: z.string(),
  link: z.string().optional(),
});

const sddStatusSchema = z.object({
  phase: sddStatusPhaseSchema,
  gate: z.string().nullable(),
  gateStatus: z.enum(['pending', 'approved', 'rejected']).nullable(),
  attempt: z.number(),
  link: z.string().nullable(),
  updatedAt: z.number(),
  history: z.array(sddEventSchema),
});

const phaseSessionSchema = z.object({
  phase: sddPhaseSchema,
  sessionKey: z.string(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  status: z.enum(['active', 'paused', 'completed', 'error']),
});

const feedbackSchema = z.object({
  at: z.number(),
  by: taskActorSchema,
  note: z.string(),
});

const runLinkSchema = z.object({
  sessionKey: z.string(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  status: z.enum(['running', 'done', 'error', 'aborted']),
  error: z.string().optional(),
});

const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10_000).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  createdBy: taskActorSchema.default('operator'),
  sourceSessionKey: z.string().max(500).optional(),
  assignee: taskActorSchema.optional(),
  labels: z.array(z.string().max(100)).max(50).default([]),
  model: z.string().max(200).optional(),
  thinking: thinkingSchema.optional(),
  dueAt: z.number().optional(),
  estimateMin: z.number().min(0).optional(),
});

const updateTaskSchema = z.object({
  version: z.number().int().min(1),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10_000).optional().nullable(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  assignee: taskActorSchema.optional().nullable(),
  labels: z.array(z.string().max(100)).max(50).optional(),
  model: z.string().max(200).optional().nullable(),
  thinking: thinkingSchema.optional().nullable(),
  dueAt: z.number().optional().nullable(),
  estimateMin: z.number().min(0).optional().nullable(),
  actualMin: z.number().min(0).optional().nullable(),
  result: z.string().max(50_000).optional().nullable(),
  resultAt: z.number().optional().nullable(),
  run: runLinkSchema.optional().nullable(),
  feedback: z.array(feedbackSchema).optional(),
  phaseSessions: z.array(phaseSessionSchema).optional().nullable(),
  currentPhase: sddPhaseSchema.optional().nullable(),
  sddStatus: sddStatusSchema.optional().nullable(),
});

const reorderSchema = z.object({
  version: z.number().int().min(1),
  targetStatus: taskStatusSchema,
  targetIndex: z.number().int().min(0),
});

const columnSchema = z.object({
  key: taskStatusSchema,
  title: z.string().min(1).max(100),
  wipLimit: z.number().int().min(0).optional(),
  visible: z.boolean(),
});

const configSchema = z.object({
  columns: z.array(columnSchema).min(1).max(10).optional(),
  defaults: z.object({
    status: taskStatusSchema,
    priority: taskPrioritySchema,
  }).optional(),
  reviewRequired: z.boolean().optional(),
  allowDoneDragBypass: z.boolean().optional(),
  quickViewLimit: z.number().int().min(1).max(50).optional(),
  proposalPolicy: z.enum(['confirm', 'auto']).optional(),
  defaultModel: z.string().max(100).optional(),
  defaultThinking: z.string().max(20).optional(),
});

// ── Proposal schemas ─────────────────────────────────────────────────

const proposalStatusSchema = z.enum(['pending', 'approved', 'rejected']);

const proposalCreatePayloadSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10_000).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  assignee: taskActorSchema.optional(),
  labels: z.array(z.string().max(100)).max(50).optional(),
  model: z.string().max(200).optional(),
  thinking: thinkingSchema.optional(),
  dueAt: z.number().optional(),
  estimateMin: z.number().min(0).optional(),
});

const proposalUpdatePayloadSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10_000).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  assignee: taskActorSchema.optional(),
  labels: z.array(z.string().max(100)).max(50).optional(),
  result: z.string().max(50_000).optional(),
});

const createProposalSchema = z.object({
  type: z.enum(['create', 'update']),
  payload: z.record(z.string(), z.unknown()),
  sourceSessionKey: z.string().max(500).optional(),
  proposedBy: taskActorSchema.default('operator'),
});

const rejectProposalSchema = z.object({
  reason: z.string().max(5000).optional(),
});

// ── Workflow schemas ─────────────────────────────────────────────────

const executeSchema = z.object({
  model: z.string().max(200).optional(),
  thinking: thinkingSchema.optional(),
  context: z.string().max(5000).optional(),
});

const approveSchema = z.object({
  note: z.string().max(5000).optional(),
});

const rejectSchema = z.object({
  note: z.string().min(1).max(5000),
  resetTo: z.enum(['fix', 'revise-plan', 'revise-spec']).default('fix'),
});

const abortSchema = z.object({
  note: z.string().max(5000).optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────

function parseArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  // Each item might be comma-separated (e.g. "todo,backlog")
  return items.flatMap((s) => s.split(',').map((v) => v.trim()).filter(Boolean));
}

// ── Routes ───────────────────────────────────────────────────────────

// GET /api/kanban/tasks
app.get('/api/kanban/tasks', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();
  const url = new URL(c.req.url);

  const status = parseArray(url.searchParams.getAll('status').length > 0
    ? url.searchParams.getAll('status')
    : url.searchParams.get('status[]') ? url.searchParams.getAll('status[]') : undefined,
  ) as TaskStatus[];

  const priority = parseArray(url.searchParams.getAll('priority').length > 0
    ? url.searchParams.getAll('priority')
    : url.searchParams.get('priority[]') ? url.searchParams.getAll('priority[]') : undefined,
  ) as TaskPriority[];

  const assignee = url.searchParams.get('assignee') || undefined;
  const label = url.searchParams.get('label') || undefined;
  const q = url.searchParams.get('q') || undefined;
  const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined;
  const offset = url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : undefined;

  const result = await store.listTasks({ status, priority, assignee, label, q, limit, offset });
  return c.json(result);
});

// POST /api/kanban/tasks
app.post('/api/kanban/tasks', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'validation_error', details: 'Invalid JSON body' }, 400);
  }

  const parsed = createTaskSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, 400);
  }

  const task = await store.createTask(parsed.data);
  return c.json(task, 201);
});

// PATCH /api/kanban/tasks/:id
app.patch('/api/kanban/tasks/:id', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();
  const id = c.req.param('id');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'validation_error', details: 'Invalid JSON body' }, 400);
  }

  const parsed = updateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, 400);
  }

  const { version, ...rawPatch } = parsed.data;

  // Convert nulls to undefined for optional clearing
  const cleanPatch = Object.fromEntries(
    Object.entries(rawPatch)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, v === null ? undefined : v]),
  ) as Record<string, unknown>;

  try {
    const updated = await store.updateTask(id, version, cleanPatch);
    return c.json(updated);
  } catch (err) {
    if (err instanceof VersionConflictError) {
      return c.json({
        error: 'version_conflict',
        serverVersion: err.serverVersion,
        latest: err.latest,
      }, 409);
    }
    if (err instanceof TaskNotFoundError) {
      return c.json({ error: 'not_found', details: err.message }, 404);
    }
    throw err;
  }
});

// DELETE /api/kanban/tasks/:id
app.delete('/api/kanban/tasks/:id', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();
  const id = c.req.param('id');

  try {
    await store.deleteTask(id, 'operator');
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      return c.json({ error: 'not_found', details: err.message }, 404);
    }
    throw err;
  }
});

// POST /api/kanban/tasks/:id/reorder
app.post('/api/kanban/tasks/:id/reorder', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();
  const id = c.req.param('id');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'validation_error', details: 'Invalid JSON body' }, 400);
  }

  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, 400);
  }

  try {
    const task = await store.reorderTask(
      id,
      parsed.data.version,
      parsed.data.targetStatus,
      parsed.data.targetIndex,
      'operator',
    );
    return c.json(task);
  } catch (err) {
    if (err instanceof VersionConflictError) {
      return c.json({
        error: 'version_conflict',
        serverVersion: err.serverVersion,
        latest: err.latest,
      }, 409);
    }
    if (err instanceof TaskNotFoundError) {
      return c.json({ error: 'not_found', details: err.message }, 404);
    }
    throw err;
  }
});

// GET /api/kanban/config
app.get('/api/kanban/config', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();
  const config = await store.getConfig();
  return c.json(config);
});

// PUT /api/kanban/config
app.put('/api/kanban/config', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'validation_error', details: 'Invalid JSON body' }, 400);
  }

  const parsed = configSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, 400);
  }

  const config = await store.updateConfig(parsed.data);
  return c.json(config);
});

// ── Proposal routes ──────────────────────────────────────────────────

// GET /api/kanban/proposals
app.get('/api/kanban/proposals', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();
  const url = new URL(c.req.url);
  const statusParam = url.searchParams.get('status') as ProposalStatus | null;

  // Validate status param if provided
  if (statusParam) {
    const parsed = proposalStatusSchema.safeParse(statusParam);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', details: 'Invalid status filter' }, 400);
    }
  }

  const proposals = await store.listProposals(statusParam ?? undefined);
  return c.json({ proposals });
});

// POST /api/kanban/proposals
app.post('/api/kanban/proposals', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'validation_error', details: 'Invalid JSON body' }, 400);
  }

  const parsed = createProposalSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, 400);
  }

  const { type, payload, sourceSessionKey, proposedBy } = parsed.data;

  // Validate payload against type-specific schema
  let safePayload: Record<string, unknown>;
  if (type === 'create') {
    const payloadParsed = proposalCreatePayloadSchema.safeParse(payload);
    if (!payloadParsed.success) {
      return c.json({
        error: 'validation_error',
        details: payloadParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      }, 400);
    }
    safePayload = payloadParsed.data;
  } else {
    const payloadParsed = proposalUpdatePayloadSchema.safeParse(payload);
    if (!payloadParsed.success) {
      return c.json({
        error: 'validation_error',
        details: payloadParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      }, 400);
    }
    safePayload = payloadParsed.data;
    // Validate that referenced task exists
    try {
      await store.getTask(safePayload.id as string);
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        return c.json({ error: 'not_found', details: `Referenced task not found: ${safePayload.id}` }, 404);
      }
      throw err;
    }
  }

  try {
    const proposal = await store.createProposal({ type, payload: safePayload, sourceSessionKey, proposedBy });
    return c.json(proposal, 201);
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      return c.json({ error: 'not_found', details: err.message }, 404);
    }
    throw err;
  }
});

// POST /api/kanban/proposals/:id/approve
app.post('/api/kanban/proposals/:id/approve', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();
  const id = c.req.param('id');

  try {
    const { proposal, task } = await store.approveProposal(id);
    return c.json({ proposal, task });
  } catch (err) {
    if (err instanceof ProposalNotFoundError) {
      return c.json({ error: 'not_found', details: err.message }, 404);
    }
    if (err instanceof ProposalAlreadyResolvedError) {
      return c.json({ error: 'already_resolved', proposal: err.proposal }, 409);
    }
    if (err instanceof TaskNotFoundError) {
      return c.json({ error: 'not_found', details: err.message }, 404);
    }
    throw err;
  }
});

// POST /api/kanban/proposals/:id/reject
app.post('/api/kanban/proposals/:id/reject', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();
  const id = c.req.param('id');

  let body: unknown = {};
  try {
    const text = await c.req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return c.json({ error: 'validation_error', details: 'Invalid JSON body' }, 400);
  }

  const parsed = rejectProposalSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, 400);
  }

  try {
    const proposal = await store.rejectProposal(id, parsed.data.reason);
    return c.json({ proposal });
  } catch (err) {
    if (err instanceof ProposalNotFoundError) {
      return c.json({ error: 'not_found', details: err.message }, 404);
    }
    if (err instanceof ProposalAlreadyResolvedError) {
      return c.json({ error: 'already_resolved', proposal: err.proposal }, 409);
    }
    throw err;
  }
});

// ── Workflow helpers ──────────────────────────────────────────────────

function handleWorkflowError(c: Context, err: unknown) {
  if (err instanceof InvalidTransitionError) {
    return c.json({
      error: 'invalid_transition',
      from: err.from,
      to: err.to,
      message: err.message,
    }, 409);
  }
  if (err instanceof TaskNotFoundError) {
    return c.json({ error: 'not_found', details: err.message }, 404);
  }
  throw err;
}

// POST /api/kanban/tasks/:id/execute
app.post('/api/kanban/tasks/:id/execute', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();
  const id = c.req.param('id');

  let body: unknown = {};
  try {
    const text = await c.req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return c.json({ error: 'validation_error', details: 'Invalid JSON body' }, 400);
  }

  const parsed = executeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, 400);
  }

  try {
    // Guard: reject if task is already in-progress (double-click race)
    const existing = await store.getTask(id);
    if (existing.status === 'in-progress') {
      return c.json({ error: 'duplicate_execution', details: 'Task is already being executed' }, 409);
    }

    const task = await store.executeTask(id, parsed.data, 'operator');

    // Append active-work indicator to result log so the UI shows what's being worked on
    const taskDescription = task.description || task.title;
    const labels = (task.labels || []) as string[];
    const isSddTask = labels.some((l: string) => /^phase-|^product|^infra/.test(l));

    if (isSddTask) {
      // Initialize or update structured sddStatus
      const isRetry = task.sddStatus && task.sddStatus.attempt > 0;
      if (isRetry) {
        await store.incrementSddAttempt(id, 'Re-executing after previous run');
        // Re-read to get updated version
        const refreshed = await store.getTask(id);
        task.version = refreshed.version;
        task.sddStatus = refreshed.sddStatus;
      } else {
        // Determine starting phase from existing sddStatus or default to specify
        const startPhase = task.sddStatus?.phase || 'specify';
        await store.setSddPhase(id, startPhase === 'done' ? 'specify' : startPhase, 'Execution started');
        const refreshed = await store.getTask(id);
        task.version = refreshed.version;
        task.sddStatus = refreshed.sddStatus;
        if (task.sddStatus && task.sddStatus.attempt === 0) {
          task.sddStatus.attempt = 1;
        }
      }

      // Also keep the legacy result log for backward compat
      // AND set structured sddStatus based on where we're resuming from
      const sddTagRe = /\[sdd:([^\]]+)\]/g;
      const sddMatches = task.result ? [...task.result.matchAll(sddTagRe)] : [];
      const lastStep = sddMatches.length > 0 ? sddMatches[sddMatches.length - 1][1] : null;
      const NEXT_ACTIVE: Record<string, string> = {
        'Reset': 'Specifying',
        'Start': 'Specifying',
        'Clarify': 'Specifying',
        'Spec Review': 'Planning',
        'Plan Review': 'Implementing',
        'PR Review': 'Complete',
      };
      // Map the display label to the structured phase
      const LABEL_TO_PHASE: Record<string, string> = {
        'Specifying': 'specify',
        'Planning': 'plan',
        'Implementing': 'implement',
        'Complete': 'done',
      };
      const activeLabel = lastStep ? (NEXT_ACTIVE[lastStep] || null) : 'Specifying';
      if (activeLabel) {
        const now = new Date().toISOString();
        const logEntry = `[${now}] [sdd:${activeLabel}] In progress.`;
        const updatedResult = task.result ? task.result + '\n' + logEntry : logEntry;
        await store.updateTask(id, task.version, { result: updatedResult });
        task.result = updatedResult;
        task.version += 1;

        // Set structured sddStatus to match
        const structuredPhase = LABEL_TO_PHASE[activeLabel];
        if (structuredPhase) {
          await store.setSddPhase(id, structuredPhase as any, `Resuming: ${activeLabel}`).catch(() => {});
        }
      }
    }

    // Extract gh:N issue number and risk level from labels
    const ghLabel = labels.find((l: string) => l.startsWith('gh:'));
    const ghIssue = ghLabel ? ghLabel.split(':')[1] : '';
    const riskLabel = labels.find((l: string) => l.startsWith('risk:'));
    const risk = riskLabel ? riskLabel.split(':')[1] : 'full';
    const workId = ghIssue || id;

    let taskPrompt: string;
    if (isSddTask) {
      taskPrompt = [
        `You are executing an SDD task. Use the Lobster pipeline — do NOT freelance the steps.`,
        ``,
        `## Task: ${task.title}`,
        `## Task ID: ${id}`,
        `## GitHub Issue: ${ghIssue ? `#${ghIssue}` : '(none — pipeline will create one)'}`,
        `## Risk Level: ${risk}`,
        `## Description: ${taskDescription}`,
        `## Labels: ${labels.join(', ')}`,
        ``,
        `## How This Works`,
        ``,
        `Lobster runs the full SDD pipeline as one continuous process. It pauses at gates`,
        `(clarify, spec-review, plan-review, pr-review) and produces a resume token.`,
        `You are one agent in a chain — a previous agent may have run Lobster partway`,
        `and left a resume token for you. Or you may be the first agent starting fresh.`,
        `Either way: your job is to run or resume Lobster, handle gates, then exit when done.`,
        `The operator approves spec/clarify gates; you handle plan and implementation autonomously.`,
        ``,
        `## EXEC TIMEOUT RULE (CRITICAL)`,
        ``,
        `When running \`lobster run\` or \`lobster resume\`, ALWAYS use \`timeout: 3600\` (1 hour).`,
        `Implementation steps spawn Claude Code which can take 30-60+ minutes for large features.`,
        `A short timeout kills the entire process tree (lobster → claude), orphaning work.`,
        `Use \`yieldMs: 30000\` and then poll the process periodically. NEVER use timeout < 3600 for Lobster.`,
        ``,
        `## Instructions`,
        ``,
        `1. Read the "For Spawned Agents" section in AGENTS.md for architecture rules.`,
        `2. Check dependencies: if task labels include depends:phase-X, verify those are done on the board.`,
        `   If not done: [kanban:update]{"id":"${id}","status":"blocked","result":"Blocked by Phase X."}[/kanban:update] and STOP.`,
        `3. Create or switch to the worktree:`,
        `   \`\`\`bash`,
        `   if [ -d "../work-${workId}" ]; then`,
        `     cd "../work-${workId}"`,
        `   else`,
        `     git fetch origin main`,
        `     git worktree add "../work-${workId}" origin/main`,
        `     cd "../work-${workId}"`,
        `   fi`,
        `   \`\`\``,
        `   **BRANCH RULE: Always branch from origin/main. NEVER merge other feature branches.**`,
        `   If the code you need is not on main, the task has an unmet dependency — block the task`,
        `   and report it. Do not merge feature branches to work around missing dependencies.`,
        `   The PR diff must show ONLY the work from this task, not other features.`,
        `4. **Pre-resume: apply operator feedback** (if resuming from a saved token)`,
        `   If there is Prior Feedback below AND a resume token exists:`,
        `   - Read the spec dir artifacts and the feedback`,
        `   - If feedback contains answers to clarification questions or correction requests:`,
        `     - Edit the relevant files to incorporate the answers (e.g. replace [NEEDS CLARIFICATION] markers with the operator's answers)`,
        `     - Commit: \`git add -A && git commit -m "fix(gh-${ghIssue || 'N'}): apply operator feedback"\` and push`,
        `   - Then proceed to resume Lobster`,
        ``,
        `5. Check if a resume token exists at /tmp/sdd-resume-${id}.token`,
        `   - **If yes — RESUME (this is the normal case after a gate approval):**`,
        `     First, sync pipeline infrastructure from main:`,
        `     \`git fetch origin main && git merge origin/main --no-edit -m "chore: sync from main" || true\``,
        `     Then resume Lobster:`,
        `     \`lobster resume --token "$(cat /tmp/sdd-resume-${id}.token)" --approve yes\``,
        `     This tells Lobster the operator approved the last gate. Lobster will continue`,
        `     to the next step and eventually hit the next gate (or complete).`,
        `   - **If no token — FRESH RUN (first execution of this task):**`,
        `     \`\`\`bash`,
        `     lobster run --mode tool --file .lobster/sdd-pipeline.lobster \\`,
        `       --args-json '{"description":"${task.title.replace(/'/g, "\\'")}", "issue":"${ghIssue}","risk":"${risk}","workdir":"../work-${workId}","task_id":"${id}"}'`,
        `     \`\`\``,
        `6. When Lobster returns needs_approval (gate):`,
        `   - **IMMEDIATELY** save the resumeToken to /tmp/sdd-resume-${id}.token — do this FIRST, before anything else.`,
        `     This is critical: if you timeout during the quality check, the next agent needs this token.`,
        `   - Parse the gate name, branch, and link from the output`,
        ``,
        `   **Quality check (BEFORE presenting to operator):**`,
        `   a. Read the generated artifacts (spec.md, test-intent.md, plan.md, tasks.md — whichever are new/changed for this gate).`,
        `   b. Compare them against Prior Feedback (below) and the PRD (.specify/memory/prd.md).`,
        `   c. Determine which gate you are at:`,
        ``,
        `   **If at spec-review gate:**`,
        `   - **For prior feedback violations** (spec ignores or contradicts explicit operator feedback):`,
        `     - Edit the spec/test-intent files directly to fix these. The operator already told you what they want.`,
        `     - Run \`git add -A && git commit -m "fix(gh-${ghIssue || 'N'}): incorporate prior feedback"\` and push.`,
        `     - Keep a detailed record of every change as a diff summary.`,
        `   - **For scope issues** (spec missing PRD requirements, or spec includes things not in the task description):`,
        `     - Do NOT edit the spec directly. These are scope decisions for the operator.`,
        `     - Add \`[NEEDS CLARIFICATION]\` markers to the spec for each scope question.`,
        `     - Format: \`[NEEDS CLARIFICATION: PRD §X requires Y but the spec does/doesn't include it. Recommendation: <your recommendation and why>]\``,
        `     - Commit and push with the markers. The clarify gate will present them to the operator.`,
        `   - If no issues found, proceed directly to presenting.`,
        ``,
        `   **If at plan-review gate:**`,
        `   - Review the generated plan and tasks against the PRD and prior feedback.`,
        `   - If the cross-model review (auto-plan-review step) found issues:`,
        `     - Evaluate each finding against the PRD. Is it a real problem?`,
        `     - For valid findings: edit plan.md and tasks.md directly to fix them.`,
        `     - For invalid findings (e.g. contradicts operator-approved decisions): ignore them.`,
        `     - Commit fixes: \`git add -A && git commit -m "fix(gh-${ghIssue || 'N'}): address cross-model review findings"\` and push.`,
        `   - If the plan itself contradicts feedback or misses requirements:`,
        `     - Write a corrective prompt describing exactly what needs to change.`,
        `     - Resume Lobster with rejection: \`lobster resume --token "$(cat /tmp/sdd-resume-${id}.token)" --reject "<your corrective prompt>"\``,
        `     - Re-check the new output. You may retry up to 2 times.`,
        `   - After fixes (or if no issues): approve the gate and continue to implementation.`,
        `     Resume Lobster: \`lobster resume --token "$(cat /tmp/sdd-resume-${id}.token)" --approve yes\``,
        `     Save the NEW resume token if Lobster hits another gate.`,
        ``,
        `   **If at any other non-spec gate (pr-review, etc.):**`,
        `   - Same as plan-review: review, fix what makes sense, approve and continue.`,
        ``,
        `   **Only present to operator at spec-review and clarify gates:**`,
        `   - Update kanban with structured SDD status:`,
        `     For clarify: [kanban:update]{"id":"${id}","status":"needs-input","result":"[sdd:Clarify][link:{link}] {summary}","sddGate":"clarify","sddLink":"{link}","sddSummary":"{summary}"}[/kanban:update]`,
        `     For spec-review: [kanban:update]{"id":"${id}","status":"needs-input","result":"[sdd:Spec Review][link:{link}] {summary}","sddGate":"spec-review","sddLink":"{link}","sddSummary":"{summary}"}[/kanban:update]`,
        `   - Include: summary of artifacts, corrections/retries if any, review link.`,
        `   - Then EXIT. Do not stay alive. The operator will approve via the UI,`,
        `     which triggers a new agent with the saved resume token.`,
        ``,
        `7. When Lobster returns ok (pipeline complete):`,
        `   - Update kanban: [kanban:update]{"id":"${id}","status":"review","result":"[sdd:PR Review][link:{pr}] Pipeline complete.","sddPhase":"review","sddLink":"{pr}","sddSummary":"PR ready for review"}[/kanban:update]`,
        `   - Clean up: rm /tmp/sdd-resume-${id}.token`,
        `   - EXIT.`,
        ``,
        `## KANBAN MARKER FORMAT`,
        ``,
        `Always include structured SDD fields in [kanban:update] markers so the board shows correct status:`,
        ``,
        `| When | Fields to include |`,
        `|------|------------------|`,
        `| Starting plan generation | \`"sddPhase":"plan"\` |`,
        `| Starting implementation | \`"sddPhase":"implement"\` |`,
        `| At a gate (clarify/spec-review) | \`"sddGate":"{gate-name}", "sddLink":"{url}", "sddSummary":"{text}"\` |`,
        `| Pipeline complete (PR) | \`"sddPhase":"review", "sddLink":"{pr-url}"\` |`,
        `| Done (merged) | \`"sddPhase":"done"\` |`,
        ``,
        `Example: [kanban:update]{"id":"${id}","status":"in-progress","result":"...","sddPhase":"implement"}[/kanban:update]`,
        ``,
        `## CRITICAL`,
        `- ALWAYS run Lobster (resume or fresh). Never skip it. Never freelance SDD steps.`,
        `- At spec/clarify gates: present to operator and EXIT (human review required)`,
        `- At plan-review gates: review cross-model findings yourself, fix valid ones, then approve and continue — do NOT stop for operator`,
        `- At implementation/PR gates: approve and continue autonomously`,
        `- You may edit plan.md and tasks.md directly to fix review findings`,
        `- TESTS MUST ACTUALLY RUN: Do NOT claim tests pass without running them. The verify step runs unit, acceptance (Testcontainers), and E2E tests. If acceptance tests exist but vitest.acceptance.config.ts is missing, CREATE IT. If tests fail, fix them. "Tests written" ≠ "tests pass".`,
        `- Do NOT decide step order — Lobster enforces it`,
        `- Do NOT present artifacts from a previous gate — only present what THIS Lobster run produced`,
        `- PRD is the source of truth — do not invent states, fields, or behaviors beyond the PRD`,
        ``,
        `## PROGRESS LOG`,
        `Write progress updates to /tmp/sdd-progress-${id}.log throughout your run.`,
        `Append one line per action: \`echo "$(date -u +%H:%M:%S) <what you are doing>" >> /tmp/sdd-progress-${id}.log\``,
        `Update BEFORE each major step: starting Lobster, reading spec, quality check, editing files, presenting.`,
        `This lets the operator monitor progress without waiting for you to finish.`,
      ].join('\n');
    } else {
      taskPrompt = `You are working on a Kanban task.\n\nTitle: ${task.title}\n\nDescription: ${taskDescription}\n\nDeliver your result as a clear summary of what was done.`;
    }

    // Append operator context and prior feedback to the prompt
    if (parsed.data.context) {
      taskPrompt += `\n\n## Operator Context\n${parsed.data.context}`;
    }
    if (task.feedback.length > 0) {
      const feedbackBlock = task.feedback
        .map(fb => `[${new Date(fb.at).toISOString()}] ${fb.by}: ${fb.note}`)
        .join('\n');
      taskPrompt += `\n\n## Prior Feedback\n${feedbackBlock}`;
    }

    const sessionLabel = `kb-${id}`;
    const spawnArgs: Record<string, unknown> = {
      task: taskPrompt,
      mode: 'run',
      label: sessionLabel,
      runTimeoutSeconds: 7200,
    };
    // Use task's model, or board default. If neither is set, omit — OpenClaw
    // will use whatever default model the operator configured in openclaw.json.
    const config = await store.getConfig();
    const model = task.model || config.defaultModel;
    if (model) spawnArgs.model = model;
    const thinking = task.thinking || config.defaultThinking;
    if (thinking) spawnArgs.thinking = thinking;

    const runLabel = sessionLabel;
    invokeGatewayTool('sessions_spawn', spawnArgs)
      .then(() => {
        // Poll for session completion in the background
        pollSessionCompletion(store, id, runLabel);
      })
      .catch((err) => {
        console.error(`[kanban] Failed to spawn session for task ${id}:`, err);
        store.completeRun(id, undefined, `Spawn failed: ${err.message}`).catch(() => {});
      });

    return c.json(task);
  } catch (err) {
    return handleWorkflowError(c, err);
  }
});

// POST /api/kanban/tasks/:id/approve
app.post('/api/kanban/tasks/:id/approve', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();
  const id = c.req.param('id');

  let body: unknown = {};
  try {
    const text = await c.req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return c.json({ error: 'validation_error', details: 'Invalid JSON body' }, 400);
  }

  const parsed = approveSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, 400);
  }

  try {
    // Store original status before approve mutates it
    const preApproveTask = await store.getTask(id);
    const wasNeedsInput = preApproveTask.status === 'needs-input';

    const task = await store.approveTask(id, parsed.data.note, 'operator');

    // Update structured sddStatus if present
    if (preApproveTask.sddStatus?.gate) {
      await store.approveSddGate(id, `${preApproveTask.sddStatus.gate} approved by operator`);
      const refreshed = await store.getTask(id);
      task.sddStatus = refreshed.sddStatus;
      task.version = refreshed.version;
    }

    // Append approval to result log (legacy), preserving the gate name from the last [sdd:*] entry
    const now = Date.now();
    const ts = new Date(now).toISOString();
    // Parse last SDD step from result to use in the approval entry
    const sddTagRe = /\[sdd:([^\]]+)\]/g;
    const resultText = preApproveTask.result || '';
    const sddMatches = [...resultText.matchAll(sddTagRe)];
    const lastSddStep = sddMatches.length > 0 ? sddMatches[sddMatches.length - 1][1] : 'Gate';
    const logEntry = `\n[${ts}] [sdd:${lastSddStep}] Approved by operator.`;
    const updatedResult = (task.result || '') + logEntry;
    await store.updateTask(id, task.version, { result: updatedResult });
    task.result = updatedResult;
    task.version += 1;

    // Option A: if approved from needs-input (gate approval), auto-trigger execute
    // The next agent will find the resume token and continue the Lobster pipeline
    if (wasNeedsInput) {
      const labels = (task.labels || []) as string[];
      const isSddTask = labels.some((l: string) => /^phase-|^product|^infra/.test(l));
      if (isSddTask) {
        // Fire-and-forget: re-execute to resume Lobster from the saved token
        // Small delay so the approve response returns first
        setTimeout(async () => {
          try {
            // task is now in 'todo' after approve — execute will move to in-progress
            const freshTask = await store.getTask(id);
            if (freshTask.status === 'todo') {
              // Trigger the execute route logic internally
              const executeUrl = `http://127.0.0.1:${c.req.header('host')?.split(':')[1] || '3080'}/api/kanban/tasks/${id}/execute`;
              await fetch(executeUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
            }
          } catch (err) {
            console.warn(`[kanban] Auto-execute after approve failed for ${id}:`, err);
          }
        }, 500);
      }
    }

    return c.json(task);
  } catch (err) {
    return handleWorkflowError(c, err);
  }
});

// POST /api/kanban/tasks/:id/reject
app.post('/api/kanban/tasks/:id/reject', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();
  const id = c.req.param('id');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'validation_error', details: 'Invalid JSON body' }, 400);
  }

  const parsed = rejectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, 400);
  }

  try {
    const task = await store.rejectTask(id, parsed.data.note, 'operator');

    // Update structured sddStatus if present
    if (task.sddStatus) {
      await store.rejectSddGate(id, parsed.data.note);
      const refreshed = await store.getTask(id);
      task.sddStatus = refreshed.sddStatus;
      task.version = refreshed.version;
    }

    // Mark current phase session as error and set reset target
    const RESET_PHASE_MAP: Record<string, SddPhase> = {
      'fix': 'implement',       // default — stays in current phase
      'revise-plan': 'plan',
      'revise-spec': 'specify',
    };

    if (task.phaseSessions?.length) {
      const now = Date.now();
      const ts = new Date(now).toISOString();
      const sessions = [...task.phaseSessions];
      const activeIdx = sessions.findIndex(s => s.status === 'active');
      if (activeIdx !== -1) {
        const currentPhase = sessions[activeIdx].phase;
        sessions[activeIdx] = { ...sessions[activeIdx], status: 'error', endedAt: now };

        // For 'fix', reset to current phase (not always implement)
        const resetPhase = parsed.data.resetTo === 'fix'
          ? currentPhase
          : RESET_PHASE_MAP[parsed.data.resetTo] || currentPhase;

        // Append rejection to the result log
        const stepName = PHASE_GATE_STEP[currentPhase as SddPhase] || currentPhase;
        const resetLabel = parsed.data.resetTo === 'fix' ? 'Fix in place' : `Reset to ${parsed.data.resetTo.replace('revise-', '')}`;
        const logEntry = `\n[${ts}] [sdd:${stepName}] REJECTED: ${parsed.data.note} (${resetLabel})`;
        const updatedResult = (task.result || '') + logEntry;

        await store.updateTask(id, task.version, {
          phaseSessions: sessions,
          currentPhase: resetPhase,
          result: updatedResult,
        });
        task.phaseSessions = sessions;
        task.currentPhase = resetPhase;
        task.result = updatedResult;
        task.version += 1;
      } else {
        await store.updateTask(id, task.version, { phaseSessions: sessions });
        task.phaseSessions = sessions;
        task.version += 1;
      }
    }

    // Auto-execute after reject — the next agent picks up the rejection feedback
    // and revises the spec/plan. Same pattern as approve auto-execute.
    const rejectLabels = (task.labels || []) as string[];
    const isRejectSddTask = rejectLabels.some((l: string) => /^phase-|^product|^infra/.test(l));
    if (isRejectSddTask && task.status === 'todo') {
      setTimeout(async () => {
        try {
          const freshTask = await store.getTask(id);
          if (freshTask.status === 'todo') {
            const executeUrl = `http://127.0.0.1:${c.req.header('host')?.split(':')[1] || '3080'}/api/kanban/tasks/${id}/execute`;
            await fetch(executeUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            });
          }
        } catch (err) {
          console.warn(`[kanban] Auto-execute after reject failed for ${id}:`, err);
        }
      }, 500);
    }

    return c.json(task);
  } catch (err) {
    return handleWorkflowError(c, err);
  }
});

// POST /api/kanban/tasks/:id/abort
app.post('/api/kanban/tasks/:id/abort', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();
  const id = c.req.param('id');

  let body: unknown = {};
  try {
    const text = await c.req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return c.json({ error: 'validation_error', details: 'Invalid JSON body' }, 400);
  }

  const parsed = abortSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, 400);
  }

  try {
    const task = await store.abortTask(id, parsed.data.note, 'operator');
    return c.json(task);
  } catch (err) {
    return handleWorkflowError(c, err);
  }
});

// ── Completion webhook ───────────────────────────────────────────────

const completeSchema = z.object({
  result: z.string().max(50_000).optional(),
  error: z.string().max(5000).optional(),
});

// POST /api/kanban/tasks/:id/complete
app.post('/api/kanban/tasks/:id/complete', rateLimitGeneral, async (c) => {
  const store = getKanbanStore();
  const id = c.req.param('id');

  let body: unknown = {};
  try {
    const text = await c.req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return c.json({ error: 'validation_error', details: 'Invalid JSON body' }, 400);
  }

  const parsed = completeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, 400);
  }

  try {
    let resultText = parsed.data.result;

    // Parse kanban markers from the result text and create proposals
    if (resultText && !parsed.data.error) {
      const markers = parseKanbanMarkers(resultText);
      for (const marker of markers) {
        try {
          await store.createProposal({
            type: marker.type,
            payload: marker.payload,
            sourceSessionKey: `complete:${id}`,
            proposedBy: 'operator',
          });
        } catch (err) {
          console.warn(`[kanban] Failed to create proposal from marker in complete:`, err);
        }
      }
      if (markers.length > 0) {
        resultText = stripKanbanMarkers(resultText);
      }
    }

    const task = await store.completeRun(id, resultText, parsed.data.error);
    return c.json(task);
  } catch (err) {
    return handleWorkflowError(c, err);
  }
});

// GET /api/kanban/tasks/:id/progress
// Returns the last line of the agent progress log and when it was written
app.get('/api/kanban/tasks/:id/progress', rateLimitGeneral, async (c) => {
  const id = c.req.param('id');
  const logPath = `/tmp/sdd-progress-${id}.log`;

  try {
    const { readFileSync, statSync } = await import('node:fs');
    const stat = statSync(logPath);
    const content = readFileSync(logPath, 'utf-8').trim();
    const lines = content.split('\n');
    const lastLine = lines[lines.length - 1] || '';
    const modifiedAt = stat.mtimeMs;
    const ageMs = Date.now() - modifiedAt;

    return c.json({
      lastLine,
      modifiedAt,
      ageMs,
      ageMinutes: Math.round(ageMs / 60000),
      totalLines: lines.length,
    });
  } catch {
    return c.json({ lastLine: null, ageMs: null, ageMinutes: null, totalLines: 0 });
  }
});

export default app;
