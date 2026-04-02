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
  'Clarify',
  'Spec Review',
  'Plan Review',
  'Implementing',
  'PR Review',
  'Complete',
  'Reset',
  'lobster-broken',
] as const;

/** The ordered SDD steps for progress display */
export const SDD_PROGRESS_STEPS = [
  { key: 'Clarify', label: 'Clarify' },
  { key: 'Spec Review', label: 'Spec Review' },
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

  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].sddStep) {
      lastStep = entries[i].sddStep;
      lastLink = entries[i].link;
      isLastApproved = entries[i].isApproved;
      isLastRejected = entries[i].isRejected;
      break;
    }
  }

  return { entries, lastStep, lastLink, isLastApproved, isLastRejected };
}

// ── Display helpers ──────────────────────────────────────────────────

export type SddBadgeTone = 'waiting' | 'approved' | 'rejected' | 'active';

/**
 * Determine what the card badge should show, using authoritative fields
 * with the result log as a fallback.
 */
export function getSddBadgeInfo(task: {
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
