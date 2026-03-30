import {
  getRootAgentId,
  getSessionDisplayLabel,
  getTopLevelAgentSessions,
} from '@/features/sessions/sessionKeys';
import type { Session } from '@/types';
import { getSessionKey } from '@/types';

export interface AssigneeOption {
  value: string;
  label: string;
  disabled?: boolean;
}

const BASE_ASSIGNEE_OPTIONS: AssigneeOption[] = [
  { value: '', label: 'Unassigned' },
  { value: 'operator', label: 'Operator' },
];

function buildActiveAgentOptions(sessions: Session[], agentName = 'Agent'): AssigneeOption[] {
  return getTopLevelAgentSessions(sessions)
    .map((session) => {
      const rootId = getRootAgentId(getSessionKey(session));
      if (!rootId || rootId === 'main') return null;

      return {
        value: `agent:${rootId}`,
        label: getSessionDisplayLabel(session, agentName),
      } satisfies AssigneeOption;
    })
    .filter((option): option is AssigneeOption => option !== null)
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

function humanizeStaleValue(value: string): string {
  const readable = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[:/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!readable) return value;
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

function buildStaleCurrentOption(currentValue: string): AssigneeOption {
  const match = currentValue.match(/^agent:([^:]+)(?::.*)?$/);
  const readableLabel = match?.[1] && match[1] !== 'main'
    ? `Agent ${humanizeStaleValue(match[1]).toLowerCase()}`
    : humanizeStaleValue(currentValue);

  return {
    value: currentValue,
    label: `${readableLabel} (inactive)`,
    disabled: true,
  };
}

export function buildAssigneeOptions(sessions: Session[], agentName = 'Agent'): AssigneeOption[] {
  return [
    ...BASE_ASSIGNEE_OPTIONS,
    ...buildActiveAgentOptions(sessions, agentName),
  ];
}

export function buildAssigneeOptionsForEdit(
  sessions: Session[],
  currentValue?: string | null,
  agentName = 'Agent',
): AssigneeOption[] {
  const options = buildAssigneeOptions(sessions, agentName);
  const trimmedCurrentValue = currentValue?.trim() ?? '';

  if (!trimmedCurrentValue) return options;
  if (options.some((option) => option.value === trimmedCurrentValue)) return options;

  return [
    ...options,
    buildStaleCurrentOption(trimmedCurrentValue),
  ];
}
