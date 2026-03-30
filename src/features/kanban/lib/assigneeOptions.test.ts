import { describe, expect, it } from 'vitest';
import type { Session } from '@/types';
import {
  buildAssigneeOptions,
  buildAssigneeOptionsForEdit,
} from './assigneeOptions';

function session(sessionKey: string, extra: Partial<Session> = {}): Session {
  return { sessionKey, ...extra };
}

describe('assigneeOptions', () => {
  it('puts Unassigned and Operator before alphabetized top-level agent roots', () => {
    const sessions = [
      session('agent:main:main'),
      session('agent:reviewer:main', { label: 'Reviewer' }),
      session('agent:designer:main', { displayName: 'Alpha Agent' }),
    ];

    expect(buildAssigneeOptions(sessions, 'Nerve')).toEqual([
      { value: '', label: 'Unassigned' },
      { value: 'operator', label: 'Operator' },
      { value: 'agent:designer', label: 'Alpha Agent' },
      { value: 'agent:reviewer', label: 'Reviewer' },
    ]);
  });

  it('maps assignable options to canonical values only', () => {
    const sessions = [
      session('agent:main:main'),
      session('agent:builder:main', { label: 'Builder' }),
    ];

    expect(buildAssigneeOptions(sessions, 'Nerve').map((option) => option.value)).toEqual([
      '',
      'operator',
      'agent:builder',
    ]);
  });

  it('ignores non-top-level sessions', () => {
    const sessions = [
      session('agent:main:main'),
      session('agent:builder:main', { label: 'Builder' }),
      session('agent:builder:subagent:child', { label: 'Builder child' }),
      session('agent:builder:cron:daily', { label: 'Daily cron' }),
      session('agent:builder:telegram:direct:123', { displayName: 'Telegram DM' }),
    ];

    expect(buildAssigneeOptions(sessions, 'Nerve')).toEqual([
      { value: '', label: 'Unassigned' },
      { value: 'operator', label: 'Operator' },
      { value: 'agent:builder', label: 'Builder' },
    ]);
  });

  it('appends a disabled stale-current option in edit mode when the current value is missing from active roots', () => {
    const sessions = [
      session('agent:main:main'),
      session('agent:reviewer:main', { label: 'Reviewer' }),
    ];

    expect(buildAssigneeOptionsForEdit(sessions, 'agent:designer', 'Nerve')).toEqual([
      { value: '', label: 'Unassigned' },
      { value: 'operator', label: 'Operator' },
      { value: 'agent:reviewer', label: 'Reviewer' },
      { value: 'agent:designer', label: 'Agent designer (inactive)', disabled: true },
    ]);
  });
});
