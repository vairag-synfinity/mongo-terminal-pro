import { Box, Text, useInput } from 'ink';
import React from 'react';
import { describeHosts } from '../../connection/manual-connection.js';
import { formatDuration } from '../../utils/formatting.js';
import { Muted } from '../components/feedback.js';
import { Panel } from '../components/panel.js';
import { SelectList, type SelectItem } from '../components/select-list.js';
import { useAppState, useScreenActive, useUi, type ScreenName } from '../context.js';
import { useAsync } from '../hooks/use-async.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';

interface MenuTarget {
  screen: ScreenName;
  params?: Record<string, unknown>;
  needsConnection: boolean;
}

export function Dashboard() {
  const { app, nav, theme, symbols } = useUi();
  const state = useAppState();
  const active = useScreenActive();
  const layout = useLayout();
  const profiles = useAsync(() => app.connections.list(), [state.connectionId]);

  useHints([
    { key: '↑↓', label: 'navigate' },
    { key: 'Enter', label: 'select' },
    { key: '1-13', label: 'jump' },
    { key: 'Esc', label: 'back' },
  ]);
  useInput(
    (_input, key) => {
      if (key.escape) nav.back();
    },
    { isActive: active },
  );

  const db = state.database;
  const collectionPicker = (next: ScreenName, title: string): MenuTarget => ({
    screen: 'picker',
    params: { need: 'collection', next, title },
    needsConnection: true,
  });
  const entries: [string, string, MenuTarget, string][] = [
    [
      'DATABASE MANAGEMENT',
      'Database Explorer',
      { screen: 'workspace', needsConnection: true },
      'Tree of databases and collections with tabbed collection views',
    ],
    [
      '',
      'Collection Explorer',
      db
        ? { screen: 'collections', params: { db }, needsConnection: true }
        : {
            screen: 'picker',
            params: { need: 'database', next: 'collections', title: 'Select database' },
            needsConnection: true,
          },
      'Collections, counts, sizes and indexes',
    ],
    [
      '',
      'Document Manager',
      collectionPicker('documents', 'Select collection'),
      'Paginated documents: view, insert, edit, delete',
    ],
    [
      '',
      'Query Builder',
      { screen: 'query', params: {}, needsConnection: true },
      'find / count / distinct / update / delete with safeguards',
    ],
    [
      '',
      'Aggregation Builder',
      collectionPicker('aggregation', 'Select collection'),
      'Build, validate and run pipelines',
    ],
    [
      'DATA MANAGEMENT',
      'Import Data',
      { screen: 'import', params: {}, needsConnection: true },
      'JSON, JSONL, CSV and BSON with validation',
    ],
    [
      '',
      'Export Data',
      { screen: 'export', params: {}, needsConnection: true },
      'JSON (Extended/plain), CSV and BSON streaming export',
    ],
    [
      '',
      'Backup / Restore',
      { screen: 'backup', params: {}, needsConnection: true },
      'mongodump / mongorestore with verification',
    ],
    [
      '',
      'Copy / Migrate',
      { screen: 'copy', params: {}, needsConnection: true },
      'Copy collections or whole databases to another database or connection',
    ],
    [
      'ADVANCED',
      'Index Manager',
      collectionPicker('indexes', 'Select collection'),
      'View, create and drop indexes; usage stats',
    ],
    [
      '',
      'Database Statistics',
      { screen: 'monitoring', needsConnection: true },
      'Server, replica set, storage and pool information',
    ],
    [
      '',
      'Connection Manager',
      { screen: 'connections', params: {}, needsConnection: false },
      'Add, import, edit and switch connections',
    ],
    [
      '',
      'Settings',
      { screen: 'settings', needsConnection: false },
      'Theme, limits, timeouts, credential storage',
    ],
  ];
  const items: SelectItem<MenuTarget>[] = entries.map(([section, label, target, description], i) => ({
    key: label,
    label,
    value: target,
    section: section || undefined,
    shortcut: String(i + 1),
    description,
    disabled: target.needsConnection && !state.connected,
    disabledReason: 'connect first',
  }));

  const server = app.connectionManager.serverInfo;
  const profile = app.connectionManager.activeProfile;
  const menuWidth = layout.wide ? 50 : layout.width - 2;
  const info = (
    <Panel title="Connection" width={layout.wide ? layout.width - menuWidth - 2 : undefined} flexGrow={1}>
      {state.connected && profile ? (
        <Box flexDirection="column">
          <Text>
            <Text color={col(theme, theme.colors.success)}>{symbols.bullet} </Text>
            <Text bold>{profile.name}</Text>
            {profile.production ? <Text color={col(theme, theme.colors.error)}> PRODUCTION</Text> : null}
          </Text>
          <Text>
            Server: {server?.isAtlas ? 'MongoDB Atlas' : 'MongoDB'} {server?.version}
          </Text>
          <Text>
            Topology: {server?.topology}
            {server?.replicaSetName ? ` (${server.replicaSetName})` : ''}
          </Text>
          <Text>Hosts: {describeHosts(profile.uri)}</Text>
          <Text>User: {profile.username ?? '(none)'}</Text>
          <Text>
            Since:{' '}
            {app.connectionManager.connectedSince
              ? formatDuration(Date.now() - app.connectionManager.connectedSince.getTime())
              : '—'}
          </Text>
          <Text>
            Access:{'   '}
            <Text color={col(theme, state.writeEnabled ? theme.colors.warning : theme.colors.success)}>
              {state.readOnlyLocked ? 'locked read-only' : state.writeEnabled ? 'write enabled' : 'read-only'}
            </Text>
          </Text>
          {state.database ? (
            <Text>
              Context: {state.database}
              {state.collection ? `.${state.collection}` : ''}
            </Text>
          ) : null}
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color={col(theme, theme.colors.muted)}>{symbols.bullet} Not connected</Text>
          <Text> </Text>
          {profiles.data && profiles.data.length > 0 ? (
            <>
              <Text>Saved connections: {profiles.data.length}</Text>
              <Muted>Open the Connection Manager (12) to connect.</Muted>
            </>
          ) : (
            <>
              <Text>No saved connections yet.</Text>
              <Muted>Open the Connection Manager (12) to add one manually,</Muted>
              <Muted>import from MongoDB Compass or from a project .env file.</Muted>
            </>
          )}
        </Box>
      )}
    </Panel>
  );

  return (
    <Box flexDirection={layout.wide ? 'row' : 'column'} height={layout.height}>
      <Panel title="Main menu" focus width={menuWidth}>
        <SelectList
          items={items}
          focus={active}
          height={Math.max(5, layout.wide ? layout.height - 3 : layout.height - (layout.compact ? 3 : 12))}
          width={menuWidth - 4}
          onSelect={(item) => nav.push(item.value.screen, item.value.params ?? {})}
        />
      </Panel>
      {layout.wide || !layout.compact ? info : null}
    </Box>
  );
}
