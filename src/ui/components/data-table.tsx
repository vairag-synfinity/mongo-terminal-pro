import { Box, Text, useInput } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { displayWidth, padEnd, padStart, truncate } from '../../utils/formatting.js';
import { visibleWindow } from '../../utils/pagination.js';
import { useUi } from '../context.js';
import { useMouseWheel } from '../hooks/use-mouse.js';
import { col } from '../themes/theme.js';

export interface Column<T> {
  key: string;
  title: string;
  /** Fixed width; omit for flexible columns that share the remaining width. */
  width?: number;
  minWidth?: number;
  align?: 'left' | 'right';
  render(row: T): string;
  color?(row: T): string | undefined;
  /** Lower numbers are hidden first on narrow terminals. */
  priority?: number;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey(row: T): string;
  focus: boolean;
  height: number;
  width: number;
  onSelect?(row: T, index: number): void;
  onHighlight?(row: T | undefined, index: number): void;
  onKey?(input: string, row: T | undefined, index: number): void;
  emptyText?: string;
  initialIndex?: number;
}

/** Fits columns into the available width, dropping low-priority columns first. */
export function layoutColumns<T>(
  columns: Column<T>[],
  width: number,
): { column: Column<T>; width: number }[] {
  let visible = [...columns];
  const gap = 1;
  const minTotal = (cols: Column<T>[]) => cols.reduce((a, c) => a + (c.width ?? c.minWidth ?? 8) + gap, 2);
  while (visible.length > 1 && minTotal(visible) > width) {
    const candidates = visible.filter((c) => c.priority !== undefined);
    if (candidates.length === 0) break;
    const drop = candidates.reduce((lowest, c) => ((c.priority ?? 0) < (lowest.priority ?? 0) ? c : lowest));
    visible = visible.filter((c) => c !== drop);
  }
  const fixed = visible.reduce((a, c) => a + (c.width ?? 0), 0);
  const flexCols = visible.filter((c) => c.width === undefined);
  const remaining = Math.max(0, width - 2 - fixed - gap * visible.length);
  const flexWidth = flexCols.length ? Math.floor(remaining / flexCols.length) : 0;
  return visible.map((c) => ({ column: c, width: c.width ?? Math.max(c.minWidth ?? 6, flexWidth) }));
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  focus,
  height,
  width,
  onSelect,
  onHighlight,
  onKey,
  emptyText = 'No rows',
  initialIndex = 0,
}: DataTableProps<T>) {
  const { theme, symbols } = useUi();
  const [index, setIndex] = useState(initialIndex);
  const offset = useRef(0);

  useEffect(() => {
    if (index >= rows.length && rows.length > 0) setIndex(rows.length - 1);
  }, [rows.length, index]);

  useEffect(() => {
    onHighlight?.(rows[index], index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, rows]);

  const move = (d: number) => setIndex((i) => Math.max(0, Math.min(rows.length - 1, i + d)));
  useMouseWheel((d) => move(d * 3), focus);

  useInput(
    (input, key) => {
      if (key.upArrow) return move(-1);
      if (key.downArrow) return move(1);
      if (key.pageUp) return move(-(height - 2));
      if (key.pageDown) return move(height - 2);
      if (key.home) return setIndex(0);
      if (key.end) return setIndex(Math.max(0, rows.length - 1));
      if (key.return && rows[index] !== undefined) return onSelect?.(rows[index] as T, index);
      onKey?.(input, rows[index], index);
    },
    { isActive: focus },
  );

  const layout = layoutColumns(columns, width);
  const bodyHeight = Math.max(1, height - 1);
  const win = visibleWindow(rows.length, index, bodyHeight, offset.current);
  offset.current = win.start;
  const cell = (text: string, w: number, align?: 'left' | 'right') => {
    const t = truncate(text, w);
    return align === 'right' ? padStart(t, w) : padEnd(t, w);
  };

  return (
    <Box flexDirection="column" width={width}>
      <Text bold color={col(theme, theme.colors.title)}>
        {'  '}
        {layout.map((l) => cell(l.column.title, l.width, l.column.align)).join(' ')}
      </Text>
      {rows.length === 0 ? <Text color={col(theme, theme.colors.muted)}> {emptyText}</Text> : null}
      {rows.slice(win.start, win.end).map((row, i) => {
        const rowIndex = win.start + i;
        const selected = rowIndex === index && focus;
        return (
          <Box key={rowKey(row)} flexShrink={0}>
            <Text color={col(theme, theme.colors.accent)}>{selected ? `${symbols.pointer} ` : '  '}</Text>
            {layout.map((l, ci) => {
              const color = l.column.color?.(row);
              return (
                <Text
                  key={l.column.key}
                  color={col(
                    theme,
                    selected && !theme.noColor ? theme.colors.selectionFg : (color ?? theme.colors.text),
                  )}
                  backgroundColor={selected && !theme.noColor ? theme.colors.selectionBg : undefined}
                  inverse={selected && theme.noColor}
                >
                  {cell(l.column.render(row), l.width, l.column.align)}
                  {ci < layout.length - 1 ? ' ' : ''}
                </Text>
              );
            })}
          </Box>
        );
      })}
      {rows.length > bodyHeight ? (
        <Text color={col(theme, theme.colors.muted)}>
          {'  '}
          {`${index + 1}/${rows.length}`}
        </Text>
      ) : null}
    </Box>
  );
}

export function widthOf(text: string): number {
  return displayWidth(text);
}
