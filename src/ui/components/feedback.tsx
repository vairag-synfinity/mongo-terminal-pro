import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import React, { useEffect } from 'react';
import type { Notification } from '../../core/application-state.js';
import { toFriendlyError } from '../../core/error-handler.js';
import { truncate } from '../../utils/formatting.js';
import { useUi } from '../context.js';
import { asciiFallback, col } from '../themes/theme.js';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  const { theme, symbols } = useUi();
  return (
    <Box>
      <Text color={col(theme, theme.colors.primary)}>
        <Spinner type={symbols.spinner} />
      </Text>
      <Text> {label}</Text>
      <Text color={col(theme, theme.colors.muted)}> (Esc to cancel)</Text>
    </Box>
  );
}

export function ProgressBar({
  fraction,
  width,
  label,
}: {
  fraction: number | undefined;
  width: number;
  label?: string;
}) {
  const { theme, symbols } = useUi();
  const barWidth = Math.max(10, width - 8);
  if (fraction === undefined) {
    return (
      <Box>
        <Text color={col(theme, theme.colors.primary)}>
          <Spinner type={symbols.spinner} />
        </Text>
        <Text> {label}</Text>
      </Box>
    );
  }
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * barWidth);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={col(theme, theme.colors.primary)}>{symbols.barFull.repeat(filled)}</Text>
        <Text color={col(theme, theme.colors.muted)}>{symbols.barEmpty.repeat(barWidth - filled)}</Text>
        <Text> {`${Math.round(f * 100)}%`.padStart(4)}</Text>
      </Box>
      {label ? <Text color={col(theme, theme.colors.muted)}>{label}</Text> : null}
    </Box>
  );
}

export function ErrorBox({ error, title }: { error: unknown; title?: string }) {
  const { theme, symbols } = useUi();
  const f = toFriendlyError(error);
  const details = (error as { details?: string[] }).details ?? [];
  return (
    <Box
      flexDirection="column"
      borderStyle={symbols.borderStyle}
      borderColor={col(theme, theme.colors.error)}
      paddingX={1}
    >
      <Text bold color={col(theme, theme.colors.error)}>
        {symbols.cross} {title ?? f.title}
      </Text>
      <Text wrap="wrap">{f.message}</Text>
      {details.slice(0, 8).map((d, i) => (
        <Text key={i} color={col(theme, theme.colors.error)} wrap="wrap">
          {'  '}- {d}
        </Text>
      ))}
      {f.hint ? (
        <Text color={col(theme, theme.colors.muted)} wrap="wrap">
          {symbols.info} {f.hint}
        </Text>
      ) : null}
    </Box>
  );
}

export function Badge({
  label,
  tone,
}: {
  label: string;
  tone: 'success' | 'warning' | 'error' | 'info' | 'muted';
}) {
  const { theme } = useUi();
  const color = tone === 'muted' ? theme.colors.muted : theme.colors[tone];
  if (theme.noColor) return <Text bold>[{label}]</Text>;
  return (
    <Text backgroundColor={color} color={theme.name === 'light' ? 'white' : 'black'} bold>
      {` ${label} `}
    </Text>
  );
}

export interface KeyHint {
  key: string;
  label: string;
}

/** Footer key hints; drops trailing hints when the terminal is narrow. */
export function KeyHints({ hints, width }: { hints: KeyHint[]; width: number }) {
  const { theme, symbols } = useUi();
  const sep = symbols.unicode ? ' │ ' : ' | ';
  const parts: KeyHint[] = [];
  let used = 0;
  for (const raw of hints) {
    const h = {
      key: asciiFallback(raw.key, symbols.unicode),
      label: asciiFallback(raw.label, symbols.unicode),
    };
    const w = h.key.length + h.label.length + 4;
    if (used + w > width) break;
    parts.push(h);
    used += w;
  }
  return (
    <Box>
      {parts.map((h, i) => (
        <Text key={`${h.key}-${i}`}>
          <Text bold color={col(theme, theme.colors.accent)}>
            {h.key}
          </Text>
          <Text color={col(theme, theme.colors.muted)}> {h.label}</Text>
          {i < parts.length - 1 ? <Text color={col(theme, theme.colors.muted)}>{sep}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

const AUTO_DISMISS_MS: Record<Notification['level'], number | undefined> = {
  info: 4000,
  success: 4000,
  warning: 8000,
  error: undefined,
};

export function Notifications({
  items,
  width,
  onDismiss,
}: {
  items: Notification[];
  width: number;
  onDismiss(id: number): void;
}) {
  const { theme, symbols } = useUi();
  useEffect(() => {
    const timers = items
      .map((n) => {
        const ms = AUTO_DISMISS_MS[n.level];
        if (ms === undefined) return undefined;
        return setTimeout(() => onDismiss(n.id), Math.max(0, ms - (Date.now() - n.createdAt)));
      })
      .filter(Boolean) as NodeJS.Timeout[];
    return () => timers.forEach(clearTimeout);
  }, [items, onDismiss]);
  if (items.length === 0) return null;
  const latest = items.slice(-3);
  return (
    <Box flexDirection="column">
      {latest.map((n) => {
        const color =
          n.level === 'error'
            ? theme.colors.error
            : n.level === 'warning'
              ? theme.colors.warning
              : n.level === 'success'
                ? theme.colors.success
                : theme.colors.info;
        const icon =
          n.level === 'error'
            ? symbols.cross
            : n.level === 'warning'
              ? symbols.warning
              : n.level === 'success'
                ? symbols.check
                : symbols.info;
        const lines = (n.message ?? '').split('\n').filter(Boolean).slice(0, 3);
        return (
          <Box key={n.id} flexDirection="column">
            <Text color={col(theme, color)} bold>
              {truncate(`${icon} ${n.title}`, width)}
              {n.level === 'error' ? (
                <Text color={col(theme, theme.colors.muted)}> (Ctrl+X to dismiss)</Text>
              ) : null}
            </Text>
            {lines.map((l, i) => (
              <Text key={i} color={col(theme, theme.colors.muted)}>
                {truncate(`  ${l}`, width)}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

export function Hr({ width }: { width: number }) {
  const { theme, symbols } = useUi();
  return <Text color={col(theme, theme.colors.border)}>{symbols.hr.repeat(Math.max(0, width))}</Text>;
}

/** Secondary one-line text; truncated rather than wrapped so screen height budgets hold. */
export function Muted({
  children,
  wrap = 'truncate-end',
}: {
  children: React.ReactNode;
  wrap?: 'wrap' | 'truncate-end';
}) {
  const { theme } = useUi();
  return (
    <Text color={col(theme, theme.colors.muted)} wrap={wrap}>
      {children}
    </Text>
  );
}

export function Label({ children, color }: { children: React.ReactNode; color?: string }) {
  const { theme } = useUi();
  return (
    <Text bold color={col(theme, color ?? theme.colors.title)}>
      {children}
    </Text>
  );
}
