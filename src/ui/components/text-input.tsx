import { Text, useInput, usePaste } from 'ink';
import React, { useEffect, useState } from 'react';
import { displayWidth } from '../../utils/formatting.js';
import { isMouseSequence } from '../../utils/terminal.js';
import { useUi } from '../context.js';
import { useInputFocus } from '../hooks/use-input-focus.js';
import { col } from '../themes/theme.js';

export interface TextInputProps {
  value: string;
  onChange(value: string): void;
  onSubmit?(value: string): void;
  onCancel?(): void;
  placeholder?: string;
  /** Password field: renders bullets/asterisks. */
  mask?: boolean;
  focus: boolean;
  /** Visible width in cells; the text scrolls horizontally around the cursor. */
  width?: number;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Strips quotes and file:// prefixes that terminals add when a file is dragged onto the window. */
export function cleanDroppedPath(text: string): string {
  let t = text.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
  if (t.startsWith('file://')) {
    try {
      t = decodeURIComponent(new URL(t).pathname);
      if (/^\/[A-Za-z]:\//.test(t)) t = t.slice(1);
    } catch {
      // keep as is
    }
  }
  if (process.platform !== 'win32') t = t.replace(/\\ /g, ' ');
  return t;
}

export function TextInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  mask,
  focus,
  width = 40,
}: TextInputProps) {
  const { theme, symbols } = useUi();
  const [cursor, setCursor] = useState(value.length);
  useInputFocus(focus);

  useEffect(() => {
    if (cursor > value.length) setCursor(value.length);
  }, [value, cursor]);

  const insert = (text: string) => {
    const clean = text.replace(/\r?\n|\t/g, ' ').replace(CONTROL_CHARS, '');
    if (!clean) return;
    const next = value.slice(0, cursor) + clean + value.slice(cursor);
    onChange(next);
    setCursor(cursor + clean.length);
  };

  usePaste((text) => insert(text), { isActive: focus });

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit?.(value);
        return;
      }
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return;
      if (key.leftArrow) {
        if (key.ctrl || key.meta) {
          const before = value.slice(0, cursor).replace(/\s+$/, '');
          setCursor(Math.max(0, before.search(/\S+$/)));
        } else setCursor(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        if (key.ctrl || key.meta) {
          const m = /^\s*\S+/.exec(value.slice(cursor));
          setCursor(m ? cursor + m[0].length : value.length);
        } else setCursor(Math.min(value.length, cursor + 1));
        return;
      }
      if (key.home || (key.ctrl && input === 'a')) {
        setCursor(0);
        return;
      }
      if (key.end || (key.ctrl && input === 'e')) {
        setCursor(value.length);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        onChange(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor(cursor - 1);
        return;
      }
      if (key.ctrl && input === 'd') {
        onChange(value.slice(0, cursor) + value.slice(cursor + 1));
        return;
      }
      if (key.ctrl && input === 'u') {
        onChange(value.slice(cursor));
        setCursor(0);
        return;
      }
      if (key.ctrl && input === 'k') {
        onChange(value.slice(0, cursor));
        return;
      }
      if (key.ctrl && input === 'w') {
        const before = value.slice(0, cursor).replace(/\S+\s*$/, '');
        onChange(before + value.slice(cursor));
        setCursor(before.length);
        return;
      }
      if (key.ctrl || key.meta) return;
      if (!input || isMouseSequence(input)) return;
      insert(input);
    },
    { isActive: focus },
  );

  const shown = mask ? (symbols.unicode ? '•' : '*').repeat(value.length) : value;
  if (value.length === 0 && !focus) {
    return <Text color={col(theme, theme.colors.muted)}>{placeholder ?? ''}</Text>;
  }
  // Horizontal scrolling window around the cursor.
  const innerWidth = Math.max(4, width - 1);
  let start = 0;
  if (displayWidth(shown.slice(0, cursor)) >= innerWidth) {
    start = cursor - innerWidth + 1;
  }
  const visible = shown.slice(start, start + innerWidth);
  const cursorPos = cursor - start;
  if (!focus) {
    return <Text>{visible}</Text>;
  }
  if (value.length === 0 && placeholder) {
    return (
      <Text>
        <Text inverse> </Text>
        <Text color={col(theme, theme.colors.muted)}>{placeholder.slice(0, innerWidth - 1)}</Text>
      </Text>
    );
  }
  const before = visible.slice(0, cursorPos);
  const at = visible[cursorPos] ?? ' ';
  const after = visible.slice(cursorPos + 1);
  return (
    <Text>
      {start > 0 ? <Text color={col(theme, theme.colors.muted)}>{symbols.unicode ? '…' : '<'}</Text> : null}
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}
