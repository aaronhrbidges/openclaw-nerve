import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import type { KanbanTask } from './types';

const mockUseSessionContext = vi.fn();

vi.mock('@/contexts/SessionContext', () => ({
  useSessionContext: () => mockUseSessionContext(),
}));

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: 'task-1',
    title: 'Existing task',
    description: 'Hello',
    status: 'todo',
    priority: 'normal',
    createdBy: 'operator',
    createdAt: 1,
    updatedAt: 2,
    version: 3,
    assignee: 'agent:designer',
    labels: ['frontend'],
    columnOrder: 0,
    feedback: [],
    ...overrides,
  };
}

function renderDrawer(task: KanbanTask | null, onUpdate = vi.fn(async () => task as KanbanTask)) {
  const onDelete = vi.fn(async () => {});
  const onClose = vi.fn();
  render(
    <TaskDetailDrawer
      task={task}
      onClose={onClose}
      onUpdate={onUpdate}
      onDelete={onDelete}
    />,
  );
  return { onUpdate, onDelete, onClose };
}

describe('TaskDetailDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    mockUseSessionContext.mockReturnValue({
      sessions: [
        { sessionKey: 'agent:designer:main', label: 'Designer' },
        { sessionKey: 'agent:reviewer:main', label: 'Reviewer' },
      ],
      agentName: 'Kim',
    });
  });

  it('shows the friendly current assignee label when the task assignee is active', () => {
    renderDrawer(makeTask({ assignee: 'agent:designer' }));

    expect(screen.getByRole('combobox', { name: 'Assignee' })).toHaveValue('Designer');
  });

  it('does not render the assignee combobox inside an extra input-styled shell', () => {
    renderDrawer(makeTask({ assignee: 'agent:designer' }));

    const combobox = screen.getByRole('combobox', { name: 'Assignee' });
    expect(combobox.parentElement).not.toHaveClass('cockpit-input');
  });

  it('shows a disabled stale-current option when the current assignee is no longer active', async () => {
    const user = userEvent.setup();
    renderDrawer(makeTask({ assignee: 'agent:ghost-reviewer' }));

    await user.click(screen.getByRole('combobox', { name: 'Assignee' }));

    const staleOption = await screen.findByRole('option', { name: /ghost reviewer.*inactive/i });
    expect(staleOption).toHaveAttribute('aria-disabled', 'true');
  });

  it('saves assignee as null when Unassigned is selected', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(async () => makeTask({ assignee: undefined }));
    renderDrawer(makeTask({ assignee: 'agent:designer' }), onUpdate);

    await user.click(screen.getByRole('combobox', { name: 'Assignee' }));
    await user.click(await screen.findByRole('option', { name: 'Unassigned' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith('task-1', expect.objectContaining({ assignee: null }));
    });
  });

  it('replaces a stale assignee with an active canonical value on save', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(async () => makeTask({ assignee: 'agent:reviewer' }));
    renderDrawer(makeTask({ assignee: 'agent:ghost-reviewer' }), onUpdate);

    await user.click(screen.getByRole('combobox', { name: 'Assignee' }));
    await user.click(await screen.findByRole('option', { name: 'Reviewer' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith('task-1', expect.objectContaining({ assignee: 'agent:reviewer' }));
    });
  });
});
