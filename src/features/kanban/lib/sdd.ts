/**
 * Shared SDD constants and result log parser.
 *
 * Single source of truth for phase names, step labels, and result log parsing.
 * Used by both server routes and client display components.
 */

// ── Phase definitions ────────────────────────────────────────────────

export type SddPhase = 'specify' | 'plan' | 'implement';

export const SDD_PHASES: readonly SddPhase[] = ['specify', 'plan', 'implement'] as const;

/** Maps phase → the HITL gate step name written to the result log */
export const PHASE_GATE_STEP: Record<SddPhase, string> = {
  specify: 'Spec Review',
  plan: 'Plan Review',
  implement: 'PR Review',
};

/** Maps phase → the active-work label for display (e.g. card badge) */
export const PHASE_ACTIVE_LABEL: Record<SddPhase, string> = {
  specify: 'Specifying',
  plan: 'Planning',
  implement: 'Implementing',
};

/** All valid step names that can appear in [sdd:*] tags */
export const VALID_SDD_STEPS = [
  'Start',
  'Specifying',
  'Clarify',
  'Spec Review',
  'Planning',
  'Plan Review',
  'Implementing',
  'PR Review',
  'Complete',
  'Reset',
  'lobster-broken',
] as const;

/** The ordered SDD steps for progress display */
export const SDD_PROGRESS_STEPS = [
  { key: 'Specifying', label: 'Specifying' },
  { key: 'Spec Review', label: 'Spec Review' },
  { key: 'Planning', label: 'Planning' },
  { key: 'Plan Review', label: 'Plan Review' },
  { key: 'Implementing', label: 'Implementing' },
  { key: 'PR Review', label: 'PR Review' },
] as const;

// ── Result log parser ────────────────────────────────────────────────

export interface ResultLogEntry {
  timestamp: string;
  raw: string;
  sddStep: string | null;
  link: string | null;
  isApproved: boolean;
  isRejected: boolean;
  text: string;
}

export interface ParsedResultLog {
  entries: ResultLogEntry[];
  lastStep: string | null;
  lastLink: string | null;
  isLastApproved: boolean;
  isLastRejected: boolean;
}

const SDD_TAG_RE = /\[sdd:([^\]]+)\]/g;
const LINK_TAG_RE = /\[link:([^\]]+)\]/g;
const LOG_LINE_RE = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s*(.+)$/;

/**
 * Parse a task's result field into structured entries.
 * Returns the entries plus convenience fields for the last step.
 */
export function parseResultLog(result: string | undefined | null): ParsedResultLog {
  const empty: ParsedResultLog = {
    entries: [],
    lastStep: null,
    lastLink: null,
    isLastApproved: false,
    isLastRejected: false,
  };

  if (!result) return empty;

  const lines = result.split('\n').filter(l => l.trim());
  const entries: ResultLogEntry[] = [];

  for (const line of lines) {
    const lineMatch = line.match(LOG_LINE_RE);
    const sddMatches = [...line.matchAll(SDD_TAG_RE)];
    const linkMatches = [...line.matchAll(LINK_TAG_RE)];

    const sddStep = sddMatches.length > 0 ? sddMatches[sddMatches.length - 1][1] : null;
    const link = linkMatches.length > 0 ? linkMatches[linkMatches.length - 1][1] : null;
    const isApproved = line.includes('Approved');
    const isRejected = line.includes('REJECTED');

    // Strip tags for display text
    const text = (lineMatch ? lineMatch[2] : line)
      .replace(SDD_TAG_RE, '')
      .replace(LINK_TAG_RE, '')
      .trim();

    entries.push({
      timestamp: lineMatch ? lineMatch[1] : '',
      raw: line,
      sddStep,
      link,
      isApproved,
      isRejected,
      text,
    });
  }

  // Find last entry with an SDD step tag
  let lastStep: string | null = null;
  let lastLink: string | null = null;
  let isLastApproved = false;
  let isLastRejected = false;

  // Normalize common step name variants to canonical form
  const STEP_NORMALIZE: Record<string, string> = {
    'spec-review': 'Spec Review',
    'plan-review': 'Plan Review',
    'pr-review': 'PR Review',
    'specifying': 'Specifying',
    'planning': 'Planning',
    'implementing': 'Implementing',
    'complete': 'Complete',
    'reset': 'Reset',
    'clarify': 'Clarify',
    'start': 'Start',
  };

  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].sddStep) {
      if (!lastStep) {
        const raw = entries[i].sddStep!;
        lastStep = STEP_NORMALIZE[raw.toLowerCase()] || raw;
        isLastApproved = entries[i].isApproved;
        isLastRejected = entries[i].isRejected;
      }
      // Always use the most recent link from ANY entry (not just the last step)
      if (!lastLink && entries[i].link) {
        lastLink = entries[i].link;
      }
      if (lastStep && lastLink) break;
    }
  }

  return { entries, lastStep, lastLink, isLastApproved, isLastRejected };
}

// ── Display helpers ──────────────────────────────────────────────────

export type SddBadgeTone = 'waiting' | 'approved' | 'rejected' | 'active';

/** Structured SDD status types (mirrored from kanban-store for client use) */
export type SddStatusPhase = 'specify' | 'plan' | 'implement' | 'review' | 'done';

export interface SddEvent {
  at: number;
  phase: string;
  gate?: string;
  action: 'started' | 'gate-reached' | 'approved' | 'rejected' | 'error' | 'retry' | 'completed';
  summary: string;
  link?: string;
}

export interface SddStatus {
  phase: SddStatusPhase;
  gate: string | null;
  gateStatus: 'pending' | 'approved' | 'rejected' | null;
  attempt: number;
  link: string | null;
  updatedAt: number;
  history: SddEvent[];
}

/** Phase label for active work display */
const PHASE_DISPLAY_LABEL: Record<string, string> = {
  specify: 'Specifying',
  plan: 'Planning',
  implement: 'Implementing',
  review: 'Review',
  done: 'Complete',
};

/** Gate label for display */
const GATE_DISPLAY_LABEL: Record<string, string> = {
  'clarify': 'Clarify',
  'spec-review': 'Spec Review',
  'plan-review': 'Plan Review',
  'code-review': 'Code Review',
  'code-review-escalation': 'Code Review Escalation',
  'pr-review': 'PR Review',
};

/**
 * Determine what the card badge should show.
 * Primary: reads task.sddStatus (structured).
 * Fallback: parses task.result text (backward compat for old tasks).
 */
export function getSddBadgeInfo(task: {
  sddStatus?: SddStatus | null;
  currentPhase?: SddPhase | string | null;
  result?: string | null;
  status?: string;
}): { label: string; tone: SddBadgeTone; link: string | null } | null {
  // Primary: structured sddStatus
  if (task.sddStatus) {
    const sdd = task.sddStatus;

    // At a gate
    if (sdd.gate && sdd.gateStatus) {
      const gateLabel = GATE_DISPLAY_LABEL[sdd.gate] || sdd.gate;
      if (sdd.gateStatus === 'approved') {
        // Show next phase as active
        const phaseLabel = PHASE_DISPLAY_LABEL[sdd.phase] || sdd.phase;
        return { label: phaseLabel, tone: 'active', link: null };
      }
      if (sdd.gateStatus === 'rejected') {
        return { label: gateLabel, tone: 'rejected', link: sdd.link };
      }
      // pending
      return { label: gateLabel, tone: 'waiting', link: sdd.link };
    }

    // Active phase, no gate
    if (sdd.phase === 'done') {
      return { label: 'Complete', tone: 'approved', link: sdd.link };
    }
    const phaseLabel = PHASE_DISPLAY_LABEL[sdd.phase] || sdd.phase;
    return { label: phaseLabel, tone: 'active', link: null };
  }

  // Fallback: parse result text (backward compat)
  return getSddBadgeInfoFromResult(task);
}

/** Original badge logic from result text parsing — kept for backward compat */
function getSddBadgeInfoFromResult(task: {
  currentPhase?: SddPhase | string | null;
  result?: string | null;
  status?: string;
}): { label: string; tone: SddBadgeTone; link: string | null } | null {
  const parsed = parseResultLog(task.result);
  const phase = task.currentPhase as SddPhase | undefined | null;

  // If we have a currentPhase and the last log says approved, show the active phase label
  if (phase && parsed.isLastApproved) {
    return {
      label: PHASE_ACTIVE_LABEL[phase] || phase,
      tone: 'active',
      link: null,
    };
  }

  // If we have a last step from the log, show it
  if (parsed.lastStep) {
    return {
      label: parsed.lastStep,
      tone: parsed.isLastRejected ? 'rejected' : parsed.isLastApproved ? 'approved' : 'waiting',
      link: parsed.isLastApproved ? null : parsed.lastLink,
    };
  }

  // If we have a phase but no log, show the active label
  if (phase) {
    return {
      label: PHASE_ACTIVE_LABEL[phase] || phase,
      tone: 'active',
      link: null,
    };
  }

  return null;
}
