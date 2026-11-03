import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';
import { truncate } from '../../utils/formatting.js';
import { useUi } from '../context.js';
import { useMouseWheel } from '../hooks/use-mouse.js';
import { asciiFallback, col } from '../themes/theme.js';

export interface ScrollLine {
  text: string;
  color?: string;
  bold?: boolean;
}

/** Read-only scrollable text (logs, help, explanations). ↑↓ PgUp/PgDn Home/End. */
export function ScrollText({
  lines,
  height,
  width,
  focus,
  follow = false,
}: {
  lines: (string | ScrollLine)[];
  height: number;
  width: number;
  focus: boolean;
  follow?: boolean;
}) {
  const { theme, symbols } = useUi();
  const [top, setTop] = useState(0);
  const overflow = lines.length > height;
  if (overflow) height = Math.max(1, height - 1);
  const maxTop = Math.max(0, lines.length - height);
  useEffect(() => {
    if (follow) setTop(maxTop);
    else if (top > maxTop) setTop(maxTop);
  }, [follow, maxTop, top]);
  const scroll = (d: number) => setTop((t) => Math.max(0, Math.min(maxTop, t + d)));
  useMouseWheel((d) => scroll(d * 3), focus);
  useInput(
    (_input, key) => {
      if (key.upArrow) scroll(-1);
      else if (key.downArrow) scroll(1);
      else if (key.pageUp) scroll(-height + 1);
      else if (key.pageDown) scroll(height - 1);
      else if (key.home) setTop(0);
      else if (key.end) setTop(maxTop);
    },
    { isActive: focus },
  );
  return (
    <Box flexDirection="column" width={width}>
      {lines.slice(top, top + height).map((l, i) => {
        const line = typeof l === 'string' ? { text: l } : l;
        return (
          <Box key={top + i} flexShrink={0}>
            <Text color={col(theme, line.color ?? theme.colors.text)} bold={line.bold}>
              {truncate(asciiFallback(line.text, symbols.unicode), width) || ' '}
            </Text>
          </Box>
        );
      })}
      {overflow ? (
        <Text
          color={col(theme, theme.colors.muted)}
        >{`${top + 1}-${Math.min(lines.length, top + height)} of ${lines.length}`}</Text>
      ) : null}
    </Box>
  );
}
