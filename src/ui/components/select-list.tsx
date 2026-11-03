import { Box, Text, useInput } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { truncate } from '../../utils/formatting.js';
import { visibleWindow } from '../../utils/pagination.js';
import { useUi } from '../context.js';
import { useMouseWheel } from '../hooks/use-mouse.js';
import { col } from '../themes/theme.js';
import { TextInput } from './text-input.js';

export interface SelectItem<T = string> {
  key: string;
  label: string;
  value: T;
  description?: string;
  /** Right-aligned secondary text. */
  hint?: string;
  disabled?: boolean;
  disabledReason?: string;
  color?: string;
  /** Section heading rendered above this item. */
  section?: string;
  /** Number shortcut (1-9, 10+ via typed digits). */
  shortcut?: string;
}

export interface SelectListProps<T> {
  items: SelectItem<T>[];
  onSelect(item: SelectItem<T>): void;
  onHighlight?(item: SelectItem<T> | undefined): void;
  focus: boolean;
  /** Visible rows (sections count as rows). */
  height: number;
  width: number;
  searchable?: boolean;
  emptyText?: string;
  initialIndex?: number;
  /** Extra key handler for screen-specific shortcuts; return true if handled. */
  onKey?(input: string, item: SelectItem<T> | undefined): boolean | void;
  showDescription?: boolean;
}

/** Scrollable, searchable list with keyboard (arrows, j/k, PgUp/PgDn, Home/End, /, digits) and optional mouse wheel. */
export function SelectList<T>({
  items,
  onSelect,
  onHighlight,
  focus,
  height,
  width,
  searchable = false,
  emptyText = 'Nothing to show',
  initialIndex = 0,
  onKey,
  showDescription = true,
}: SelectListProps<T>) {
  const { theme, symbols } = useUi();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [index, setIndex] = useState(initialIndex);
  const offset = useRef(0);
  const digitBuffer = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const digitTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  useEffect(() => () => clearTimeout(digitTimer.current), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.label.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => {
    if (index >= filtered.length) setIndex(Math.max(0, filtered.length - 1));
  }, [filtered.length, index]);

  const current = filtered[index];
  useEffect(() => {
    onHighlight?.(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.key]);

  const move = (delta: number) => {
    if (filtered.length === 0) return;
    let next = index;
    for (let step = 0; step < filtered.length; step++) {
      next = Math.max(0, Math.min(filtered.length - 1, next + delta));
      if (!filtered[next]?.disabled || next === 0 || next === filtered.length - 1) break;
    }
    setIndex(next);
  };

  useMouseWheel((d) => move(d * 3), focus && !searching);

  useInput(
    (input, key) => {
      if (searching) {
        if (key.escape) {
          setSearching(false);
          setQuery('');
        } else if (key.return || key.downArrow) {
          setSearching(false);
        }
        return;
      }
      if (key.upArrow || input === 'k') return move(-1);
      if (key.downArrow || input === 'j') return move(1);
      if (key.pageUp) return move(-Math.max(1, height - 1));
      if (key.pageDown) return move(Math.max(1, height - 1));
      if (key.home || input === 'g') return setIndex(0);
      if (key.end || input === 'G') return setIndex(Math.max(0, filtered.length - 1));
      if (key.return) {
        if (current && !current.disabled) onSelect(current);
        return;
      }
      if (searchable && input === '/') {
        setSearching(true);
        return;
      }
      // Digits may arrive one per event or several at once when typed quickly.
      if (/^\d+$/.test(input) && items.some((i) => i.shortcut)) {
        const now = Date.now();
        const buf = now - digitBuffer.current.at < 700 ? digitBuffer.current.text + input : input;
        digitBuffer.current = { text: buf, at: now };
        if (digitTimer.current) clearTimeout(digitTimer.current);
        const target = filtered.findIndex((i) => i.shortcut === buf);
        if (target < 0) return;
        setIndex(target);
        const item = filtered[target];
        if (!item || item.disabled) return;
        // "1" could become "10": wait briefly for another digit before selecting.
        const ambiguous = filtered.some((i) => i.shortcut !== buf && i.shortcut?.startsWith(buf));
        if (!ambiguous) onSelect(item);
        else digitTimer.current = setTimeout(() => onSelectRef.current(item), 600);
        return;
      }
      onKey?.(input, current);
    },
    { isActive: focus },
  );

  // Rows: items plus section headings.
  const rows = useMemo(() => {
    const out: { kind: 'section' | 'item'; text: string; itemIndex: number }[] = [];
    filtered.forEach((item, i) => {
      if (item.section && !query) out.push({ kind: 'section', text: item.section, itemIndex: i });
      out.push({ kind: 'item', text: item.label, itemIndex: i });
    });
    return out;
  }, [filtered, query]);

  const selectedRow = rows.findIndex((r) => r.kind === 'item' && r.itemIndex === index);
  const listHeight = Math.max(
    1,
    height - (searchable && (searching || query) ? 1 : 0) - (showDescription && current?.description ? 1 : 0),
  );
  const win = visibleWindow(rows.length, Math.max(0, selectedRow), listHeight, offset.current);
  offset.current = win.start;
  const visibleRows = rows.slice(win.start, win.end);
  // Keep the section heading of the first visible item on screen.
  if (win.start > 0 && selectedRow === win.start && rows[win.start - 1]?.kind === 'section') {
    visibleRows.unshift(rows[win.start - 1] as (typeof rows)[number]);
    visibleRows.pop();
  }
  const labelWidth = Math.max(8, width - 4);

  return (
    <Box flexDirection="column" width={width}>
      {searchable && (searching || query) ? (
        <Box>
          <Text color={col(theme, theme.colors.accent)}>/ </Text>
          <TextInput
            value={query}
            onChange={(v) => {
              setQuery(v);
              setIndex(0);
            }}
            focus={focus && searching}
            width={width - 4}
            placeholder="type to filter"
          />
        </Box>
      ) : null}
      {filtered.length === 0 ? (
        <Text color={col(theme, theme.colors.muted)}>{query ? `No matches for "${query}"` : emptyText}</Text>
      ) : null}
      {visibleRows.map((row) => {
        if (row.kind === 'section') {
          return (
            <Box key={`s-${row.itemIndex}`} flexShrink={0}>
              <Text bold color={col(theme, theme.colors.title)}>
                {truncate(row.text.toUpperCase(), labelWidth + 2)}
              </Text>
            </Box>
          );
        }
        const item = filtered[row.itemIndex] as SelectItem<T>;
        const selected = row.itemIndex === index;
        const hint = item.disabled && item.disabledReason ? item.disabledReason : item.hint;
        const hintWidth = hint ? Math.min(hint.length, Math.floor(labelWidth / 2)) : 0;
        const prefix = item.shortcut ? `${item.shortcut.padStart(2)}. ` : '';
        const label = truncate(prefix + item.label, labelWidth - hintWidth - (hint ? 1 : 0));
        const pad = Math.max(1, labelWidth - label.length - hintWidth);
        const color = item.disabled ? theme.colors.muted : (item.color ?? theme.colors.text);
        return (
          <Box key={item.key} flexShrink={0}>
            <Text color={col(theme, theme.colors.accent)}>
              {selected && focus ? `${symbols.pointer} ` : '  '}
            </Text>
            <Text
              color={col(theme, selected && !theme.noColor ? theme.colors.selectionFg : color)}
              backgroundColor={selected && focus && !theme.noColor ? theme.colors.selectionBg : undefined}
              inverse={selected && focus && theme.noColor}
              dimColor={item.disabled}
              bold={selected}
            >
              {label}
              {hint ? ' '.repeat(pad) : ''}
            </Text>
            {hint ? <Text color={col(theme, theme.colors.muted)}>{truncate(hint, hintWidth)}</Text> : null}
          </Box>
        );
      })}
      {showDescription && current?.description ? (
        <Text color={col(theme, theme.colors.muted)} wrap="truncate-end">
          {current.description}
        </Text>
      ) : null}
    </Box>
  );
}
