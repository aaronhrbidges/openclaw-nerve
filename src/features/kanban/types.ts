// Kanban type contracts — Frozen v1
// Change policy: coordinator approval + issue-file sync required.

export type TaskStatus = 'backlog' | 'todo' | 'in-progress' | 'needs-input' | 'blocked' | 'review' | 'done' | 'cancelled';
export type TaskPriority = 'critical' | 'high' | 'normal' | 'low';

/** Canonical column display order. Single source of truth for board + header. */
export const COLUMNS: TaskStatus[] = ['backlog', 'todo', 'blocked', 'in-progress', 'needs-input', 'review', 'done'];

/** Human-readable column labels. */
export const COLUMN_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Ready',
  'in-progress': 'In Progress',
  'needs-input': 'Needs Input',
  blocked: 'Blocked',
  review: 'Review',
  done: 'Done',
  cancelled: 'Cancelled',
};
export type TaskActor = 'operator' | `agent:${string}`;

export interface TaskFeedback {
  at: number;
  by: TaskActor;
  note: string;
}

export interface TaskRunLink {
  sessionKey: string;
  sessionId?: string;
  runId?: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'done' | 'error' | 'aborted';
  error?: string;
}

export type SddPhase = 'specify' | 'plan' | 'implement';

export interface PhaseSession {
  phase: SddPhase;
  sessionKey: string;
  startedAt: number;
  endedAt?: number;
  status: 'active' | 'paused' | 'completed' | 'error';
}

export interface KanbanTask {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdBy: TaskActor;
  createdAt: number;
  updatedAt: number;
  version: number;
  sourceSessionKey?: string;
  assignee?: TaskActor;
  labels: string[];
  columnOrder: number;
  run?: TaskRunLink;
  result?: string;
  resultAt?: number;
  model?: string;
  thinking?: 'off' | 'low' | 'medium' | 'high';
  dueAt?: number;
  estimateMin?: number;
  actualMin?: number;
  feedback: TaskFeedback[];
  phaseSessions?: PhaseSession[];
  currentPhase?: SddPhase;
}
