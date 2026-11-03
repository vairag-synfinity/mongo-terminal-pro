import { Box, Text } from 'ink';
import React, { createContext, useContext, useEffect } from 'react';
import { truncate } from '../../utils/formatting.js';
import { Badge, type KeyHint } from '../components/feedback.js';
import { useAppState, useUi, type Route } from '../context.js';
import { col } from '../themes/theme.js';

export interface LayoutInfo {
  /** Width available to the screen body. */
  width: number;
  /** Height available to the screen body. */
  height: number;
  /** True on small terminals; screens should simplify (single column, fewer columns). */
  compact: boolean;
  /** True when there is room for side-by-side panes. */
  wide: boolean;
}

export const LayoutContext = createContext<LayoutInfo>({
  width: 80,
  height: 20,
  compact: false,
  wide: false,
});
export const useLayout = () => useContext(LayoutContext);

export const HintsContext = createContext<(hints: KeyHint[]) => void>(() => undefined);

/** Screens declare their key hints; the footer renders them. */
export function useHints(hints: KeyHint[], deps: unknown[] = []): void {
  const setHints = useContext(HintsContext);
  useEffect(() => {
    setHints(hints);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setHints, ...deps, JSON.stringify(hints)]);
}

const SCREEN_LABELS: Record<Route['screen'], string> = {
  dashboard: 'Dashboard',
  connections: 'Connections',
  databases: 'Databases',
  collections: 'Collections',
  collection: 'Collection',
  documents: 'Documents',
  query: 'Query Builder',
  aggregation: 'Aggregation',
  import: 'Import',
  export: 'Export',
  backup: 'Backup / Restore',
  indexes: 'Indexes',
  monitoring: 'Statistics',
  settings: 'Settings',
  help: 'Help',
  picker: 'Select',
};

export function routeLabel(route: Route): string {
  const p = route.params as { db?: string; collection?: string; title?: string };
  switch (route.screen) {
    case 'collections':
      return p.db ?? 'Collections';
    case 'collection':
      return p.collection ?? 'Collection';
    case 'picker':
      return p.title ?? 'Select';
    case 'documents':
    case 'indexes':
    case 'aggregation':
      return p.collection
        ? `${p.db}.${p.collection} ${SCREEN_LABELS[route.screen]}`
        : SCREEN_LABELS[route.screen];
    default:
      return SCREEN_LABELS[route.screen];
  }
}

export function Header({ width, compact }: { width: number; compact: boolean }) {
  const { theme, symbols, nav, app } = useUi();
  const state = useAppState();
  const server = app.connectionManager.serverInfo;
  const title = 'MONGO TERMINAL PRO';
  const statusDot = state.connected ? col(theme, theme.colors.success) : col(theme, theme.colors.muted);
  const connText = state.connected
    ? `${state.connectionName}${server && !compact ? `  ${server.isAtlas ? 'Atlas' : 'MongoDB'} ${server.version} · ${server.topology}` : ''}`
    : 'Not connected';
  const crumbs = nav.stack.map(routeLabel).join(` ${symbols.separator} `);
  const mode = !state.connected
    ? undefined
    : state.readOnlyLocked
      ? 'LOCKED READ-ONLY'
      : state.writeEnabled
        ? 'WRITE ENABLED'
        : 'READ-ONLY';
  const modeTone = state.writeEnabled ? 'warning' : 'success';
  const leftWidth = Math.max(10, width - (mode ? mode.length + 3 : 0) - (state.production ? 8 : 0));
  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between" width={width}>
        <Text bold color={col(theme, theme.colors.title)}>
          {symbols.unicode ? '◆ ' : ''}
          {title}
        </Text>
        <Text>
          <Text color={statusDot}>{symbols.bullet} </Text>
          <Text color={col(theme, state.connected ? theme.colors.text : theme.colors.muted)}>
            {truncate(connText, Math.max(10, width - title.length - 6))}
          </Text>
        </Text>
      </Box>
      <Box justifyContent="space-between" width={width}>
        <Text color={col(theme, theme.colors.muted)}>{truncate(crumbs, leftWidth)}</Text>
        <Box gap={1}>
          {state.production ? <Badge label="PROD" tone="error" /> : null}
          {mode ? <Badge label={mode} tone={modeTone} /> : null}
        </Box>
      </Box>
      <Text color={col(theme, theme.colors.border)}>{symbols.hr.repeat(width)}</Text>
    </Box>
  );
}
