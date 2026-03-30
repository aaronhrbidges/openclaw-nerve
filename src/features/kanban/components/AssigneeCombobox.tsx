import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { AssigneeOption } from '../lib/assigneeOptions';

export interface AssigneeComboboxProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: AssigneeOption[];
  ariaLabel: string;
  placeholder?: string;
  noResultsText?: string;
  noActiveAgentsText?: string;
  disabled?: boolean;
  className?: string;
  inline?: boolean;
}

function isEnabledOption(option: AssigneeOption | undefined): option is AssigneeOption {
  return Boolean(option && !option.disabled);
}

function getFirstEnabledIndex(options: AssigneeOption[]): number {
  return options.findIndex((option) => !option.disabled);
}

function getInitialHighlightIndex(options: AssigneeOption[], value: string): number {
  const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
  if (selectedIndex >= 0) return selectedIndex;
  return getFirstEnabledIndex(options);
}

function getNextEnabledIndex(options: AssigneeOption[], start: number, direction: 1 | -1): number {
  if (options.length === 0) return -1;

  let index = start;
  for (let steps = 0; steps < options.length; steps += 1) {
    index += direction;
    if (index < 0 || index >= options.length) return start;
    if (!options[index]?.disabled) return index;
  }

  return start;
}

export function AssigneeCombobox({
  id,
  value,
  onChange,
  options,
  ariaLabel,
  placeholder = 'Select assignee',
  noResultsText = 'No matching assignees',
  noActiveAgentsText = 'No active agents available',
  disabled = false,
  className,
  inline = false,
}: AssigneeComboboxProps) {
  const reactId = useId();
  const inputId = id ?? `assignee-combobox-${reactId}`;
  const listboxId = `${inputId}-listbox`;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxRef = useRef<HTMLUListElement | null>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  const filteredOptions = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return options;
    return options.filter((option) => option.label.toLowerCase().includes(query));
  }, [filter, options]);

  const selectedOption = options.find((option) => option.value === value);
  const displayValue = open ? filter : selectedOption?.label ?? '';
  const hasActiveAgents = options.some((option) => option.value.startsWith('agent:') && !option.disabled);

  const getInitialMenuStyle = useCallback((): React.CSSProperties => {
    const rect = inputRef.current?.getBoundingClientRect();
    const viewportPadding = 8;

    return {
      position: 'fixed',
      left: rect?.left ?? viewportPadding,
      top: (rect?.bottom ?? viewportPadding) + 4,
      minWidth: rect?.width,
      maxWidth: window.innerWidth - viewportPadding * 2,
      maxHeight: 320,
      visibility: 'visible',
      zIndex: 9999,
    };
  }, []);

  const openPopup = useCallback(() => {
    if (disabled) return;
    setFilter('');
    setHighlightedIndex(getInitialHighlightIndex(options, value));
    if (!inline) {
      setMenuStyle(getInitialMenuStyle());
    }
    setOpen(true);
  }, [disabled, getInitialMenuStyle, inline, options, value]);

  const closePopup = useCallback(() => {
    setOpen(false);
    setFilter('');
    setHighlightedIndex(-1);
    if (!inline) {
      setMenuStyle({});
    }
  }, [inline]);

  const selectOption = useCallback((option: AssigneeOption | undefined) => {
    if (!isEnabledOption(option)) return;
    onChange(option.value);
    closePopup();
    inputRef.current?.blur();
  }, [closePopup, onChange]);

  const resolvedHighlightedIndex = useMemo(() => {
    if (!open || filteredOptions.length === 0) return -1;
    if (highlightedIndex < 0 || highlightedIndex >= filteredOptions.length || filteredOptions[highlightedIndex]?.disabled) {
      return getInitialHighlightIndex(filteredOptions, value);
    }
    return highlightedIndex;
  }, [filteredOptions, highlightedIndex, open, value]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !listboxRef.current?.contains(target)) {
        closePopup();
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [closePopup]);

  useEffect(() => {
    if (open && resolvedHighlightedIndex >= 0 && resolvedHighlightedIndex < filteredOptions.length && listboxRef.current) {
      const item = listboxRef.current.children[resolvedHighlightedIndex] as HTMLElement | undefined;
      item?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [filteredOptions.length, open, resolvedHighlightedIndex]);

  useLayoutEffect(() => {
    if (inline || !open || !inputRef.current) return;

    const rect = inputRef.current.getBoundingClientRect();
    const menuEl = listboxRef.current;
    const viewportPadding = 8;
    const menuWidth = Math.max(rect.width, menuEl?.offsetWidth ?? 0);
    const maxAllowedLeft = Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding);
    const left = Math.min(Math.max(rect.left, viewportPadding), maxAllowedLeft);
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
    const spaceAbove = rect.top - viewportPadding;
    const shouldDropUp = spaceBelow < 220 && spaceAbove > spaceBelow;
    const availableHeight = Math.max(120, Math.min(320, shouldDropUp ? spaceAbove - 4 : spaceBelow - 4));

    if (shouldDropUp) {
      setMenuStyle({
        position: 'fixed',
        left,
        bottom: window.innerHeight - rect.top + 4,
        minWidth: rect.width,
        maxWidth: window.innerWidth - viewportPadding * 2,
        maxHeight: availableHeight,
        visibility: 'visible',
        zIndex: 9999,
      });
      return;
    }

    setMenuStyle({
      position: 'fixed',
      left,
      top: rect.bottom + 4,
      minWidth: rect.width,
      maxWidth: window.innerWidth - viewportPadding * 2,
      maxHeight: availableHeight,
      visibility: 'visible',
      zIndex: 9999,
    });
  }, [filteredOptions.length, inline, open]);

  const activeDescendantId =
    open && resolvedHighlightedIndex >= 0 && resolvedHighlightedIndex < filteredOptions.length
      ? `${inputId}-option-${resolvedHighlightedIndex}`
      : undefined;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openPopup();
      }
      return;
    }

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const nextIndex = resolvedHighlightedIndex < 0
          ? getFirstEnabledIndex(filteredOptions)
          : getNextEnabledIndex(filteredOptions, resolvedHighlightedIndex, 1);
        setHighlightedIndex(nextIndex);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const nextIndex = resolvedHighlightedIndex < 0
          ? getFirstEnabledIndex(filteredOptions)
          : getNextEnabledIndex(filteredOptions, resolvedHighlightedIndex, -1);
        setHighlightedIndex(nextIndex);
        break;
      }
      case 'Enter':
        event.preventDefault();
        selectOption(filteredOptions[resolvedHighlightedIndex]);
        break;
      case 'Escape':
        event.preventDefault();
        closePopup();
        inputRef.current?.blur();
        break;
      case 'Tab':
        closePopup();
        break;
    }
  };

  const menuContent = open && !disabled ? (
    <ul
      ref={listboxRef}
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      style={inline ? undefined : menuStyle}
      className={cn(
        'max-h-64 overflow-auto rounded-xl border border-border/80 bg-background shadow-lg',
        inline ? 'absolute left-0 top-full z-50 mt-1 min-w-full' : '',
      )}
    >
      {!filter.trim() && !hasActiveAgents && (
        <li className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
          {noActiveAgentsText}
        </li>
      )}
      {filteredOptions.length === 0 ? (
        <li className="px-3 py-2 text-sm text-muted-foreground">{noResultsText}</li>
      ) : (
        filteredOptions.map((option, index) => {
          const highlighted = index === resolvedHighlightedIndex;
          const selected = option.value === value;
          return (
            <li
              key={`${option.value}-${index}`}
              id={`${inputId}-option-${index}`}
              role="option"
              aria-selected={selected}
              aria-disabled={option.disabled}
              className={cn(
                'px-3 py-2 text-sm',
                highlighted ? 'bg-secondary/80 text-foreground' : selected ? 'bg-secondary text-foreground' : 'text-foreground/85',
                option.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-secondary/80 hover:text-foreground',
              )}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                selectOption(option);
              }}
              onPointerEnter={() => setHighlightedIndex(index)}
            >
              {option.label}
            </li>
          );
        })
      )}
    </ul>
  ) : null;

  const menu = menuContent && !inline ? createPortal(menuContent, document.body) : menuContent;

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <Input
        id={inputId}
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-activedescendant={activeDescendantId}
        aria-autocomplete="list"
        disabled={disabled}
        value={displayValue}
        placeholder={placeholder}
        onFocus={openPopup}
        onClick={openPopup}
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      {menu}
    </div>
  );
}
