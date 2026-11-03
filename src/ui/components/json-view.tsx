import { Box, Text, useInput } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { truncate } from '../../utils/formatting.js';
import { visibleWindow } from '../../utils/pagination.js';
import { useUi } from '../context.js';
import { useMouseWheel } from '../hooks/use-mouse.js';
import { col } from '../themes/theme.js';
import { containerPaths, flattenJson, kindColor } from './bson-format.js';

export interface JsonViewProps {
  value: unknown;
  focus: boolean;
  height: number;
  width: number;
  /** Depth expanded initially (0 = only the root). */
  initialDepth?: number;
}

/**
 * Interactive, syntax-highlighted JSON/BSON tree.
 * ↑↓ move · → / Enter expand · ← collapse · E expand all · C collapse all · PgUp/PgDn scroll.
 */
export function JsonView({ value, focus, height, width, initialDepth = 1 }: JsonViewProps) {
  const { theme, symbols } = useUi();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(containerPaths(value, initialDepth)));
  const [cursor, setCursor] = useState(0);
  const offset = useRef(0);

  useEffect(() => {
    setExpanded(new Set(containerPaths(value, initialDepth)));
    setCursor(0);
    offset.current = 0;
  }, [value, initialDepth]);

  const lines = useMemo(() => flattenJson(value, expanded), [value, expanded]);
  const current = lines[Math.min(cursor, lines.length - 1)];

  const toggle = (path: string, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const shouldOpen = open ?? !next.has(path);
      if (shouldOpen) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  useMouseWheel((d) => setCursor((c) => Math.max(0, Math.min(lines.length - 1, c + d * 3))), focus);

  useInput(
    (input, key) => {
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(lines.length - 1, c + 1));
      else if (key.pageUp) setCursor((c) => Math.max(0, c - height + 1));
      else if (key.pageDown) setCursor((c) => Math.min(lines.length - 1, c + height - 1));
      else if (key.home) setCursor(0);
      else if (key.end) setCursor(lines.length - 1);
      else if ((key.rightArrow || key.return) && current?.expandable)
        toggle(current.path, key.return ? undefined : true);
      else if (key.leftArrow && current) {
        if (current.expanded) toggle(current.path, false);
        else {
          // Jump to and collapse the parent container.
          const parentPath = current.path.replace(/#close$/, '').replace(/\.[^.]+$/, '');
          const parentIndex = lines.findIndex((l) => l.path === parentPath);
          if (parentIndex >= 0 && current.path !== '$') {
            toggle(parentPath, false);
            setCursor(parentIndex);
          }
        }
      } else if (input === 'E') setExpanded(new Set(containerPaths(value, 50)));
      else if (input === 'C') {
        setExpanded(new Set(['$']));
        setCursor(0);
      }
    },
    { isActive: focus },
  );

  const viewHeight = lines.length > height ? Math.max(1, height - 1) : height;
  const win = visibleWindow(lines.length, Math.min(cursor, lines.length - 1), viewHeight, offset.current);
  offset.current = win.start;
  const indentUnit = 2;

  return (
    <Box flexDirection="column" width={width}>
      {lines.slice(win.start, win.end).map((line, i) => {
        const index = win.start + i;
        const selected = focus && index === cursor;
        const indent = ' '.repeat(line.depth * indentUnit);
        const marker = line.expandable ? (line.expanded ? symbols.expanded : symbols.collapsed) : ' ';
        const keyText = line.key !== undefined ? `${line.key}: ` : '';
        const comma = line.trailingComma ? ',' : '';
        const available = Math.max(4, width - indent.length - 2 - keyText.length - comma.length);
        const valueColor =
          line.kind === 'close' || line.kind === 'object' || line.kind === 'array'
            ? theme.colors.json.punctuation
            : kindColor(line.kind, theme.colors);
        return (
          <Box key={`${line.path}-${index}`} flexShrink={0}>
            <Text inverse={selected}>
              <Text color={col(theme, theme.colors.muted)}>
                {indent}
                {marker}{' '}
              </Text>
              {keyText ? (
                <Text color={col(theme, theme.colors.json.key)}>
                  {truncate(keyText, Math.max(6, width - indent.length - 6))}
                </Text>
              ) : null}
              <Text color={col(theme, valueColor)}>{truncate(line.text, available)}</Text>
              <Text color={col(theme, theme.colors.json.punctuation)}>{comma}</Text>
            </Text>
          </Box>
        );
      })}
      {lines.length > height ? (
        <Text color={col(theme, theme.colors.muted)}>{`line ${cursor + 1}/${lines.length}`}</Text>
      ) : null}
    </Box>
  );
}
