import type { ComponentProps } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssigneeCombobox } from './AssigneeCombobox';
import type { AssigneeOption } from '../lib/assigneeOptions';

const FULL_OPTIONS: AssigneeOption[] = [
  { value: '', label: 'Unassigned' },
  { value: 'operator', label: 'Operator' },
  { value: 'agent:designer', label: 'Designer' },
  { value: 'agent:reviewer', label: 'Reviewer' },
];

function renderCombobox(props: Partial<ComponentProps<typeof AssigneeCombobox>> = {}) {
  const onChange = vi.fn();
  render(
    <AssigneeCombobox
      value=""
      onChange={onChange}
      options={FULL_OPTIONS}
      ariaLabel="Assignee"
      {...props}
    />,
  );
  return { onChange };
}

describe('AssigneeCombobox', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('opens the full list on click', async () => {
    const user = userEvent.setup();
    renderCombobox();

    await user.click(screen.getByRole('combobox', { name: 'Assignee' }));

    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Unassigned' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Operator' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Designer' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Reviewer' })).toBeInTheDocument();
  });

  it('opens the full list on focus', async () => {
    const user = userEvent.setup();
    renderCombobox();

    await user.tab();

    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Designer' })).toBeInTheDocument();
  });

  it('filters visible options as the user types', async () => {
    const user = userEvent.setup();
    renderCombobox();

    const combobox = screen.getByRole('combobox', { name: 'Assignee' });
    await user.click(combobox);
    await user.type(combobox, 'des');

    expect(await screen.findByRole('option', { name: 'Designer' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Operator' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Reviewer' })).not.toBeInTheDocument();
  });

  it('selects the highlighted option on Enter', async () => {
    const user = userEvent.setup();
    const { onChange } = renderCombobox();

    const combobox = screen.getByRole('combobox', { name: 'Assignee' });
    await user.click(combobox);
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(onChange).toHaveBeenCalledWith('agent:designer');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });

  it('closes the popup after pointer selection', async () => {
    const user = userEvent.setup();
    const { onChange } = renderCombobox();

    await user.click(screen.getByRole('combobox', { name: 'Assignee' }));
    await user.click(await screen.findByRole('option', { name: 'Designer' }));

    expect(onChange).toHaveBeenCalledWith('agent:designer');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderCombobox();

    const combobox = screen.getByRole('combobox', { name: 'Assignee' });
    await user.click(combobox);
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });

  it('renders disabled options but does not select them', async () => {
    const user = userEvent.setup();
    const { onChange } = renderCombobox({
      options: [
        ...FULL_OPTIONS,
        { value: 'agent:ghost', label: 'Agent ghost (inactive)', disabled: true },
      ],
    });

    await user.click(screen.getByRole('combobox', { name: 'Assignee' }));
    const disabledOption = await screen.findByRole('option', { name: 'Agent ghost (inactive)' });
    expect(disabledOption).toHaveAttribute('aria-disabled', 'true');

    await user.click(disabledOption);

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('shows an empty-state message when filtering yields no matches', async () => {
    const user = userEvent.setup();
    renderCombobox();

    const combobox = screen.getByRole('combobox', { name: 'Assignee' });
    await user.click(combobox);
    await user.type(combobox, 'zzz');

    expect(await screen.findByText('No matching assignees')).toBeInTheDocument();
  });

  it('shows a clear no-active-agents state when only Unassigned and Operator remain', async () => {
    const user = userEvent.setup();
    renderCombobox({
      options: [
        { value: '', label: 'Unassigned' },
        { value: 'operator', label: 'Operator' },
      ],
    });

    await user.click(screen.getByRole('combobox', { name: 'Assignee' }));

    expect(await screen.findByText('No active agents available')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Unassigned' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Operator' })).toBeInTheDocument();
  });

  it('shows the friendly selected label instead of the canonical raw value', () => {
    renderCombobox({ value: 'agent:designer' });

    expect(screen.getByRole('combobox', { name: 'Assignee' })).toHaveValue('Designer');
  });

  it('supports placeholder text', () => {
    renderCombobox({ value: '', placeholder: 'Select an assignee' });

    expect(screen.getByPlaceholderText('Select an assignee')).toBeInTheDocument();
  });

  it('renders the listbox inline when inline is enabled', async () => {
    const user = userEvent.setup();
    render(
      <div data-testid="combobox-host">
        <AssigneeCombobox
          value=""
          onChange={vi.fn()}
          options={FULL_OPTIONS}
          ariaLabel="Assignee"
          inline
        />
      </div>,
    );

    await user.click(screen.getByRole('combobox', { name: 'Assignee' }));

    const listbox = await screen.findByRole('listbox');
    expect(screen.getByTestId('combobox-host')).toContainElement(listbox);
  });

  it('keeps highlightedIndex valid when filtering shrinks the list', async () => {
    const user = userEvent.setup();
    const { onChange } = renderCombobox();

    const combobox = screen.getByRole('combobox', { name: 'Assignee' });
    await user.click(combobox);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    await user.type(combobox, 'des');
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith('agent:designer');
  });

  it('unsets aria-activedescendant when no options match the filter', async () => {
    const user = userEvent.setup();
    renderCombobox();

    const combobox = screen.getByRole('combobox', { name: 'Assignee' });
    await user.click(combobox);
    await user.type(combobox, 'zzz');

    await waitFor(() => {
      expect(combobox).not.toHaveAttribute('aria-activedescendant');
    });
  });

  it('does not preserve stale filter text after close and reopen', async () => {
    const user = userEvent.setup();
    renderCombobox();

    const combobox = screen.getByRole('combobox', { name: 'Assignee' });
    await user.click(combobox);
    await user.type(combobox, 'des');
    await user.keyboard('{Escape}');
    await user.click(combobox);

    expect(combobox).toHaveValue('');
    expect(await screen.findByRole('option', { name: 'Operator' })).toBeInTheDocument();
  });

  it('resets stale filter text when the value changes externally while closed', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AssigneeCombobox
        value=""
        onChange={vi.fn()}
        options={FULL_OPTIONS}
        ariaLabel="Assignee"
      />,
    );

    const combobox = screen.getByRole('combobox', { name: 'Assignee' });
    await user.click(combobox);
    await user.type(combobox, 'des');
    await user.keyboard('{Escape}');

    rerender(
      <AssigneeCombobox
        value="agent:reviewer"
        onChange={vi.fn()}
        options={FULL_OPTIONS}
        ariaLabel="Assignee"
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Assignee' })).toHaveValue('Reviewer');
  });

  it('respects the disabled prop', async () => {
    const user = userEvent.setup();
    renderCombobox({ disabled: true });

    const combobox = screen.getByRole('combobox', { name: 'Assignee' });
    expect(combobox).toBeDisabled();

    await user.click(combobox);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
