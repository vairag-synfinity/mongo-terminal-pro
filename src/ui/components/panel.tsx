import { Box, Text } from 'ink';
import React from 'react';
import { truncate } from '../../utils/formatting.js';
import { useUi } from '../context.js';
import { col } from '../themes/theme.js';

export interface PanelProps {
  title?: string;
  focus?: boolean;
  width?: number | string;
  height?: number;
  flexGrow?: number;
  children: React.ReactNode;
  right?: string;
}

/** Bordered section with an optional title. Uses ASCII borders when Unicode is unavailable. */
export function Panel({ title, focus, width, height, flexGrow, children, right }: PanelProps) {
  const { theme, symbols } = useUi();
  const borderColor = col(theme, focus ? theme.colors.borderFocus : theme.colors.border);
  return (
    <Box
      flexDirection="column"
      borderStyle={symbols.borderStyle}
      borderColor={borderColor}
      width={width}
      height={height}
      flexGrow={flexGrow}
      paddingX={1}
      overflow="hidden"
    >
      {title || right ? (
        <Box justifyContent="space-between">
          <Text bold color={col(theme, focus ? theme.colors.borderFocus : theme.colors.title)}>
            {title ? truncate(title, 60) : ''}
          </Text>
          {right ? <Text color={col(theme, theme.colors.muted)}>{truncate(right, 40)}</Text> : null}
        </Box>
      ) : null}
      {children}
    </Box>
  );
}
