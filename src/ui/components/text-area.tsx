import { Box, Text, useInput, usePaste } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import { isMouseSequence } from '../../utils/terminal.js';
import { useUi } from '../context.js';
import { useInputFocus } from '../hooks/use-input-focus.js';
import { col } from '../themes/theme.js';

export interface TextAreaProps {
  value: string;
  onChange(value: string): void;
  /** Ctrl+S */
  onSubmit?(value: string): void;
  /** Esc */
  onCancel?(): void;
  focus: boolean;
  height: number;
  width: number;
  lineNumbers?: boolean;
  placeholder?: string;
  /** Tab inserts two spaces (default). Forms disable this so Tab moves to the next field. */
  tabInserts?: boolean;
  /** Where the cursor starts (e.g. inside the braces of a new document). */
  initialCursor?: { row: number; col: number };
}

interface Cursor {
  row: number;
  col: number;
}

/**
 * Multi-line editor for JSON documents, filters and pipeline stages. Keyboard-only:
 * arrows, Home/End, PgUp/PgDn, Enter (auto-indent), Tab (2 spaces), Backspace, Ctrl+K (delete line),
 * Ctrl+S (save/submit), Esc (cancel). Bracketed paste inserts multi-line text in one step.
 */
export function TextArea({
  value,
  onChange,
  onSubmit,
  onCancel,
  focus,
  height,
  width,
  lineNumbers = true,
  placeholder,
  tabInserts = true,
  initialCursor,
}: TextAreaProps) {
  const { theme } = useUi();
  const lines = useMemo(() => value.split('\n'), [value]);
  const [cursor, setCursor] = useState<Cursor>(initialCursor ?? { row: 0, col: 0 });
  const [scrollY, setScrollY] = useState(0);
  useInputFocus(focus);

  const gutter = lineNumbers ? String(lines.length).length + 1 : 0;
  const textWidth = Math.max(10, width - gutter - 1);
  const rows = Math.max(1, height);

  useEffect(() => {
    // Keep the cursor inside the document when the value changes externally.
    setCursor((c) => {
      const row = Math.min(c.row, lines.length - 1);
      return { row, col: Math.min(c.col, (lines[row] ?? '').length) };
    });
  }, [lines]);

  useEffect(() => {
    if (cursor.row < scrollY) setScrollY(cursor.row);
    else if (cursor.row >= scrollY + rows) setScrollY(cursor.row - rows + 1);
  }, [cursor.row, scrollY, rows]);

  const commit = (nextLines: string[], next: Cursor) => {
    onChange(nextLines.join('\n'));
    setCursor(next);
  };

  const insertText = (text: string) => {
    // Keep newlines; drop other control characters (they would corrupt the terminal display).
    const clean = text
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '  ')
      // eslint-disable-next-line no-control-regex -- strip control characters except newlines
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '');
    if (!clean) return;
    const line = lines[cursor.row] ?? '';
    const before = line.slice(0, cursor.col);
    const after = line.slice(cursor.col);
    const parts = clean.split('\n');
    const next = [...lines];
    if (parts.length === 1) {
      next[cursor.row] = before + clean + after;
      commit(next, { row: cursor.row, col: cursor.col + clean.length });
      return;
    }
    const first = before + parts[0];
    const last = (parts[parts.length - 1] ?? '') + after;
    next.splice(cursor.row, 1, first, ...parts.slice(1, -1), last);
    commit(next, { row: cursor.row + parts.length - 1, col: (parts[parts.length - 1] ?? '').length });
  };

  usePaste((text) => insertText(text), { isActive: focus });

  useInput(
    (input, key) => {
      const line = lines[cursor.row] ?? '';
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (key.ctrl && input === 's') {
        onSubmit?.(value);
        return;
      }
      if (key.upArrow) {
        const row = Math.max(0, cursor.row - 1);
        setCursor({ row, col: Math.min(cursor.col, (lines[row] ?? '').length) });
        return;
      }
      if (key.downArrow) {
        const row = Math.min(lines.length - 1, cursor.row + 1);
        setCursor({ row, col: Math.min(cursor.col, (lines[row] ?? '').length) });
        return;
      }
      if (key.pageUp || key.pageDown) {
        const delta = key.pageUp ? -rows : rows;
        const row = Math.max(0, Math.min(lines.length - 1, cursor.row + delta));
        setCursor({ row, col: Math.min(cursor.col, (lines[row] ?? '').length) });
        return;
      }
      if (key.leftArrow) {
        if (cursor.col > 0) setCursor({ ...cursor, col: cursor.col - 1 });
        else if (cursor.row > 0)
          setCursor({ row: cursor.row - 1, col: (lines[cursor.row - 1] ?? '').length });
        return;
      }
      if (key.rightArrow) {
        if (cursor.col < line.length) setCursor({ ...cursor, col: cursor.col + 1 });
        else if (cursor.row < lines.length - 1) setCursor({ row: cursor.row + 1, col: 0 });
        return;
      }
      if (key.home || (key.ctrl && input === 'a')) {
        setCursor({ ...cursor, col: 0 });
        return;
      }
      if (key.end || (key.ctrl && input === 'e')) {
        setCursor({ ...cursor, col: line.length });
        return;
      }
      if (key.return) {
        const indent = /^\s*/.exec(line)?.[0] ?? '';
        const opensBlock = /[[{(]\s*$/.test(line.slice(0, cursor.col));
        insertText(`\n${indent}${opensBlock ? '  ' : ''}`);
        return;
      }
      if (key.tab) {
        if (tabInserts) insertText('  ');
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor.col > 0) {
          const next = [...lines];
          next[cursor.row] = line.slice(0, cursor.col - 1) + line.slice(cursor.col);
          commit(next, { ...cursor, col: cursor.col - 1 });
        } else if (cursor.row > 0) {
          const prev = lines[cursor.row - 1] ?? '';
          const next = [...lines];
          next.splice(cursor.row - 1, 2, prev + line);
          commit(next, { row: cursor.row - 1, col: prev.length });
        }
        return;
      }
      if (key.ctrl && input === 'd') {
        if (cursor.col < line.length) {
          const next = [...lines];
          next[cursor.row] = line.slice(0, cursor.col) + line.slice(cursor.col + 1);
          commit(next, cursor);
        }
        return;
      }
      if (key.ctrl && input === 'k') {
        const next = lines.length > 1 ? lines.filter((_, i) => i !== cursor.row) : [''];
        commit(next, { row: Math.min(cursor.row, next.length - 1), col: 0 });
        return;
      }
      if (key.ctrl || key.meta) return;
      if (!input || isMouseSequence(input)) return;
      insertText(input);
    },
    { isActive: focus },
  );

  const scrollX = Math.max(0, cursor.col - textWidth + 2);
  const visible = lines.slice(scrollY, scrollY + rows);
  const border = focus ? theme.colors.borderFocus : theme.colors.border;
  const isEmpty = value.length === 0;
  return (
    <Box flexDirection="column" borderStyle={undefined} width={width}>
      {visible.map((text, i) => {
        const row = scrollY + i;
        const segment = text.slice(scrollX, scrollX + textWidth);
        const isCursorRow = focus && row === cursor.row;
        const cpos = cursor.col - scrollX;
        return (
          <Box key={row} flexShrink={0}>
            {lineNumbers ? (
              <Text color={col(theme, isCursorRow ? border : theme.colors.muted)}>
                {String(row + 1).padStart(gutter - 1)}{' '}
              </Text>
            ) : null}
            {isCursorRow ? (
              <Text>
                {segment.slice(0, cpos)}
                <Text inverse>{segment[cpos] ?? ' '}</Text>
                {segment.slice(cpos + 1)}
              </Text>
            ) : isEmpty && row === 0 && placeholder ? (
              <Text color={col(theme, theme.colors.muted)}>{placeholder.slice(0, textWidth)}</Text>
            ) : (
              <Text>{segment || ' '}</Text>
            )}
          </Box>
        );
      })}
      {Array.from({ length: Math.max(0, rows - visible.length) }, (_, i) => (
        <Box key={`pad-${i}`} flexShrink={0}>
          <Text color={col(theme, theme.colors.muted)}>
            {lineNumbers ? `${' '.repeat(gutter - 1)}~` : ' '}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
