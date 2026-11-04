import { Box, Text, useInput } from 'ink';
import React, { useMemo, useState } from 'react';
import type { CollectionType } from '../../database/collection-manager.js';
import { truncate } from '../../utils/formatting.js';
import { ExplorerTree } from '../components/explorer-tree.js';
import type { KeyHint } from '../components/feedback.js';
import { Panel } from '../components/panel.js';
import {
  ScreenActiveContext,
  UiContext,
  useAppState,
  useScreenActive,
  useUi,
  type Navigation,
  type ScreenName,
} from '../context.js';
import { HintsContext, LayoutContext, useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';
import { AggregationScreen } from './aggregation-screen.js';
import { CollectionListScreen } from './collection-list-screen.js';
import { CollectionScreen } from './collection-screen.js';
import { DatabaseScreen } from './database-screen.js';
import { DocumentScreen } from './document-screen.js';
import { ExportScreen } from './export-screen.js';
import { ImportScreen } from './import-screen.js';
import { IndexScreen } from './index-screen.js';
import { QueryScreen } from './query-screen.js';

type Tab = 'documents' | 'aggregation' | 'query' | 'indexes' | 'collection' | 'import' | 'export';

const TABS: { tab: Tab; label: string; short: string; writable?: boolean }[] = [
  { tab: 'documents', label: 'Documents', short: 'Docs' },
  { tab: 'aggregation', label: 'Aggregations', short: 'Agg' },
  { tab: 'query', label: 'Query', short: 'Query' },
  { tab: 'indexes', label: 'Indexes', short: 'Idx', writable: true },
  { tab: 'collection', label: 'Schema & Stats', short: 'Schema' },
  { tab: 'import', label: 'Import', short: 'Imp', writable: true },
  { tab: 'export', label: 'Export', short: 'Exp' },
];

const TAB_SCREENS = new Set<ScreenName>(TABS.map((t) => t.tab));

interface Selection {
  db?: string;
  collection?: string;
  type?: CollectionType;
}

/**
 * Compass / NoSQLBooster-style workspace: database tree on the left, the selected database or
 * collection on the right with tabs. Existing screens are hosted in the right pane; their
 * navigation calls are redirected so "open documents" switches tab and "back" returns to the tree.
 */
export function WorkspaceScreen() {
  const ui = useUi();
  const { app, nav, theme, symbols, inputFocus } = ui;
  const state = useAppState();
  const screenActive = useScreenActive();
  const layout = useLayout();
  const [selection, setSelection] = useState<Selection>({ db: state.database, collection: state.collection });
  const [tab, setTab] = useState<Tab>('documents');
  const [tabParams, setTabParams] = useState<Record<string, unknown>>({});
  const [paneKey, setPaneKey] = useState(0);
  const [focus, setFocus] = useState<'sidebar' | 'main'>('sidebar');
  const [paneHints, setPaneHints] = useState<KeyHint[]>([]);

  const select = (
    next: Selection,
    nextTab: Tab = 'documents',
    params: Record<string, unknown> = {},
    focusMain = true,
  ) => {
    setSelection(next);
    setTab(nextTab);
    setTabParams(params);
    setPaneKey((k) => k + 1);
    app.state.set({ database: next.db, collection: next.collection });
    if (focusMain) setFocus('main');
  };

  const isView = selection.type === 'view';
  const availableTabs = TABS.filter((t) => !(isView && t.writable));

  const switchTab = (delta: number) => {
    if (!selection.collection) return;
    const i = availableTabs.findIndex((t) => t.tab === tab);
    const next = availableTabs[(i + delta + availableTabs.length) % availableTabs.length];
    if (next) select(selection, next.tab, {}, focus === 'main');
  };

  // Navigation for screens inside the pane.
  const paneNav: Navigation = useMemo(() => {
    const push: Navigation['push'] = (screen, params = {}) => {
      const p = params as { db?: string; collection?: string };
      if (screen === 'collections' && p.db) return select({ db: p.db });
      if (screen === 'databases') return select({});
      if (screen === 'collection')
        return select({ db: p.db, collection: p.collection, type: selection.type });
      if (TAB_SCREENS.has(screen)) {
        const db = p.db ?? selection.db;
        const collection = p.collection ?? selection.collection;
        if (collection) return select({ db, collection, type: selection.type }, screen as Tab, params);
      }
      nav.push(screen, params);
    };
    // "replace" and "push" both open in the pane; "back" returns to the tree.
    return { ...nav, push, replace: push, back: () => setFocus('sidebar') };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav, selection]);

  useInput(
    (input, key) => {
      // Alt+1…7 / Alt+←→ switch tabs even while typing in a form field (text inputs ignore Alt).
      if (key.meta && /^[1-7]$/.test(input) && selection.collection) {
        const target = availableTabs[Number(input) - 1];
        if (target) select(selection, target.tab, {}, focus === 'main');
        return;
      }
      if (key.meta && (key.leftArrow || key.rightArrow)) return switchTab(key.rightArrow ? 1 : -1);
      if (inputFocus.active) return;
      if (input === ']') switchTab(1);
      else if (input === '[') switchTab(-1);
      else if (key.tab && focus === 'sidebar' && (selection.db || selection.collection)) setFocus('main');
    },
    { isActive: screenActive },
  );

  const sidebarHints: KeyHint[] = [
    { key: '↑↓', label: 'move' },
    { key: '→/Enter', label: 'open' },
    { key: '←', label: 'collapse' },
    { key: '/', label: 'filter' },
    { key: 'Tab', label: 'pane' },
    { key: 'C', label: 'copy db' },
    { key: 'x/X', label: 'export db/all' },
    { key: 'I', label: 'import folder' },
    { key: 'r', label: 'refresh' },
    { key: 'm', label: 'menu' },
    { key: 'b', label: 'backup' },
    { key: 'S', label: 'stats' },
    { key: 'Esc', label: 'connections' },
  ];
  useHints(
    focus === 'sidebar'
      ? sidebarHints
      : [
          // The pane's own "Esc back" is replaced by "Esc sidebar" below.
          ...paneHints.filter((h) => h.key !== 'Esc'),
          ...(selection.collection ? [{ key: 'Alt+1-7', label: 'tabs' }] : []),
          { key: 'Esc', label: 'sidebar' },
        ],
    [focus, paneHints, selection.collection],
  );

  if (!state.connected) {
    return (
      <Panel title="Workspace" focus>
        <Text color={col(theme, theme.colors.warning)}>Not connected.</Text>
        <Text color={col(theme, theme.colors.muted)}>Press Esc to choose a connection.</Text>
        <EscBack onBack={() => nav.back()} active={screenActive} />
      </Panel>
    );
  }

  const narrow = layout.width < 90;
  const sidebarWidth = narrow ? layout.width : Math.min(38, Math.max(24, Math.floor(layout.width * 0.24)));
  const paneWidth = narrow ? layout.width : layout.width - sidebarWidth;
  const showSidebar = !narrow || focus === 'sidebar';
  const showPane = !narrow || focus === 'main';
  const tabBarHeight = selection.collection ? 1 : 0;
  const paneHeight = layout.height - tabBarHeight;

  const sidebar = (
    <Box
      flexDirection="column"
      width={sidebarWidth}
      height={layout.height}
      borderStyle={symbols.borderStyle}
      borderColor={col(theme, focus === 'sidebar' ? theme.colors.borderFocus : theme.colors.border)}
      paddingX={0}
      overflow="hidden"
    >
      <Text bold color={col(theme, focus === 'sidebar' ? theme.colors.borderFocus : theme.colors.title)}>
        {truncate(` ${symbols.bullet} ${state.connectionName ?? ''}`, sidebarWidth - 2)}
      </Text>
      <ExplorerTree
        focus={screenActive && focus === 'sidebar'}
        width={sidebarWidth - 2}
        height={layout.height - 3}
        selected={{ db: selection.db, collection: selection.collection }}
        onOpenDatabase={(db) => select({ db }, 'documents', {}, false)}
        onOpenCollection={(db, c) => select({ db, collection: c.name, type: c.type })}
        onEscape={() => nav.back()}
        onKey={(input, db) => {
          const target = db ?? selection.db;
          if (input === 'C') nav.push('copy', { db: target });
          else if (input === 'x' && target) nav.push('export', { db: target, scope: 'database' });
          else if (input === 'X') nav.push('export', { scope: 'all' });
          else if (input === 'I') nav.push('import', { db: target, folder: true });
          else if (input === 'm') nav.push('dashboard');
          else if (input === 'b') nav.push('backup', { db: selection.db });
          else if (input === 'S') nav.push('monitoring');
          else if (input === ',') nav.push('settings');
        }}
      />
    </Box>
  );

  const paneLayout = {
    width: paneWidth,
    height: paneHeight,
    compact: paneWidth < 80,
    wide: paneWidth >= 88, // side-by-side layouts already fit in a ~90-column pane
  };
  const paneActive = screenActive && focus === 'main';
  const p = { db: selection.db as string, collection: selection.collection as string, ...tabParams };
  let content: React.ReactNode;
  if (!selection.db) content = <DatabaseScreen key={`dbs-${paneKey}`} />;
  else if (!selection.collection)
    content = <CollectionListScreen key={`colls-${paneKey}`} params={{ db: selection.db }} />;
  else {
    const k = `${selection.db}.${selection.collection}:${tab}:${paneKey}`;
    switch (tab) {
      case 'documents':
        content = <DocumentScreen key={k} params={p} />;
        break;
      case 'aggregation':
        content = <AggregationScreen key={k} params={p} />;
        break;
      case 'query':
        content = <QueryScreen key={k} params={p} />;
        break;
      case 'indexes':
        content = <IndexScreen key={k} params={p} />;
        break;
      case 'collection':
        content = <CollectionScreen key={k} params={p} />;
        break;
      case 'import':
        content = <ImportScreen key={k} params={p} />;
        break;
      case 'export':
        content = <ExportScreen key={k} params={p} />;
        break;
    }
  }

  const tabBar = selection.collection ? (
    <Box width={paneWidth} flexShrink={0}>
      {availableTabs.map((t, i) => {
        const activeTab = t.tab === tab;
        const label = `${i + 1} ${paneWidth < 100 ? t.short : t.label}`;
        return (
          <Text
            key={t.tab}
            bold={activeTab}
            inverse={activeTab}
            color={col(
              theme,
              activeTab
                ? focus === 'main'
                  ? theme.colors.borderFocus
                  : theme.colors.title
                : theme.colors.muted,
            )}
          >
            {` ${label} `}
          </Text>
        );
      })}
      <Text color={col(theme, theme.colors.muted)}>{paneWidth >= 90 ? '  Alt+1-7 or [ ]' : ''}</Text>
    </Box>
  ) : null;

  const pane = (
    <Box flexDirection="column" width={paneWidth} height={layout.height}>
      {tabBar}
      <UiContext.Provider value={{ ...ui, nav: paneNav }}>
        <ScreenActiveContext.Provider value={paneActive}>
          <HintsContext.Provider value={setPaneHints}>
            <LayoutContext.Provider value={paneLayout}>
              <Box flexDirection="column" height={paneHeight} overflow="hidden">
                {content}
              </Box>
            </LayoutContext.Provider>
          </HintsContext.Provider>
        </ScreenActiveContext.Provider>
      </UiContext.Provider>
    </Box>
  );

  return (
    <Box flexDirection="row" height={layout.height}>
      {/* Both stay mounted (display: none) so narrow terminals keep tree and pane state. */}
      <Box display={showSidebar ? 'flex' : 'none'}>{sidebar}</Box>
      <Box display={showPane ? 'flex' : 'none'}>{pane}</Box>
    </Box>
  );
}

function EscBack({ onBack, active }: { onBack(): void; active: boolean }) {
  useInput(
    (_input, k) => {
      if (k.escape) onBack();
    },
    { isActive: active },
  );
  return null;
}
