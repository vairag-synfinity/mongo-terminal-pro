import { Box, Text, useInput } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  discoverCompassConnections,
  type CompassDiscoveryResult,
} from '../../connection/compass-discovery.js';
import { importDiscovered, markExisting } from '../../connection/connection-discovery.js';
import { needsPassword } from '../../connection/connection-manager.js';
import type { ConnectionProfile, DiscoveredConnection } from '../../connection/connection-types.js';
import {
  candidatesToConnections,
  collectFromEnvironment,
  collectFromProjectDirectory,
} from '../../connection/env-discovery.js';
import { describeHosts } from '../../connection/manual-connection.js';
import { maskConnectionString } from '../../security/sensitive-data-filter.js';
import { formatDateTime, truncate } from '../../utils/formatting.js';
import { useDialog } from '../components/dialog.js';
import { ErrorBox, Loading, Muted } from '../components/feedback.js';
import { Form } from '../components/form.js';
import { Panel } from '../components/panel.js';
import { DataTable, type Column } from '../components/data-table.js';
import { SelectList } from '../components/select-list.js';
import { useAppState, useScreenActive, useUi } from '../context.js';
import { useAsync } from '../hooks/use-async.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';
import { ConnectionForm } from './connection-form.js';

type View =
  | { kind: 'list' }
  | { kind: 'form'; editing?: ConnectionProfile }
  | { kind: 'compass' }
  | { kind: 'env-setup' }
  | {
      kind: 'env-results';
      connections: DiscoveredConnection[];
      secrets: Map<string, string>;
      filesRead: string[];
    };

export function ConnectionScreen({ params }: { params: { autoConnect?: string } }) {
  const { app, nav, theme, symbols, notify, notifyError } = useUi();
  const state = useAppState();
  const screenActive = useScreenActive();
  const layout = useLayout();
  const dialog = useDialog(layout.width);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [highlighted, setHighlighted] = useState<ConnectionProfile | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [refreshTick, setRefreshTick] = useState(0);
  const profiles = useAsync(
    async () => ({ list: await app.connections.list(), defaultId: await app.connections.getDefaultId() }),
    [refreshTick],
  );
  const active = screenActive && !dialog.open && !busy;
  const autoConnected = useRef(false);

  const refresh = () => setRefreshTick((t) => t + 1);

  const connect = async (profile: ConnectionProfile) => {
    if (state.connected && state.connectionId === profile.id) {
      nav.push('workspace');
      return;
    }
    let password: string | undefined;
    if (profile.username && needsPassword(profile)) {
      password = await app.connections.getPassword(profile.id).catch((e: unknown) => {
        notifyError(e, 'Stored password unavailable');
        return undefined;
      });
      if (password === undefined) {
        password = await dialog.prompt({
          title: `Password for ${profile.username}@${profile.name}`,
          label: 'Password:',
          mask: true,
          help: 'The password is kept in memory for this session only, unless you choose to save it.',
        });
        if (password === undefined) return;
        const save = await dialog.confirm({
          title: 'Remember password?',
          message: 'Store it in secure credential storage for next time?',
          confirmLabel: 'Remember',
        });
        if (save)
          await app.connections
            .setPassword(profile.id, password, true)
            .catch((e: unknown) => notifyError(e, 'Could not store password'));
      }
    }
    setBusy(`Connecting to ${profile.name}…`);
    try {
      const server = await app.connect(profile, password);
      notify(
        'success',
        `Connected to ${profile.name}`,
        `MongoDB ${server.version} · ${server.topology}. Session is read-only; press W to enable writes.`,
      );
      if (profile.production)
        notify('warning', 'Production connection', 'Be careful: this connection is marked as production.');
      nav.push('workspace');
    } catch (e) {
      notifyError(e, `Could not connect to ${profile.name}`);
    } finally {
      setBusy(undefined);
    }
  };

  useEffect(() => {
    if (autoConnected.current || !params.autoConnect || !profiles.data) return;
    autoConnected.current = true;
    const p = profiles.data.list.find((x) => x.id === params.autoConnect);
    if (p) void connect(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles.data, params.autoConnect]);

  const remove = async (p: ConnectionProfile) => {
    const ok = await dialog.confirm({
      title: 'Delete connection',
      message: [`Delete "${p.name}"?`, 'Its stored password is removed as well. Databases are not affected.'],
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    if (state.connectionId === p.id) await app.disconnect();
    await app.connections.delete(p.id);
    notify('success', `Deleted "${p.name}"`);
    refresh();
  };

  const rename = async (p: ConnectionProfile) => {
    const name = await dialog.prompt({
      title: 'Rename connection',
      label: 'New name:',
      initial: p.name,
      validate: (v) => (v.trim() ? undefined : 'Name is required'),
    });
    if (!name) return;
    try {
      await app.connections.rename(p.id, name);
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };

  const test = async (p: ConnectionProfile) => {
    let password =
      p.username && needsPassword(p)
        ? await app.connections.getPassword(p.id).catch(() => undefined)
        : undefined;
    if (p.username && needsPassword(p) && password === undefined) {
      password = await dialog.prompt({
        title: `Password for ${p.username}@${p.name}`,
        label: 'Password:',
        mask: true,
      });
      if (password === undefined) return;
    }
    setBusy(`Testing ${p.name}…`);
    const r = await app.connectionManager.test(p, password);
    setBusy(undefined);
    if (r.ok)
      notify(
        'success',
        `${p.name}: OK (${r.latencyMs} ms)`,
        `MongoDB ${r.server?.version} · ${r.server?.topology}`,
      );
    else notifyError(r.error, `${p.name}: connection failed`);
  };

  useHints(
    view.kind === 'list'
      ? [
          { key: 'Enter', label: 'connect' },
          { key: 'a', label: 'add' },
          { key: 'e', label: 'edit' },
          { key: 'd', label: 'delete' },
          { key: 'r', label: 'rename' },
          { key: 't', label: 'test' },
          { key: 'f', label: 'favorite' },
          { key: 's', label: 'default' },
          { key: 'c', label: 'Compass' },
          { key: 'v', label: '.env' },
          ...(state.connected ? [{ key: 'x', label: 'disconnect' }] : []),
          { key: 'Q', label: 'quit' },
        ]
      : [{ key: 'Esc', label: 'back to list' }],
    [view.kind, state.connected],
  );

  useInput(
    (input, key) => {
      if (view.kind !== 'list') return;
      if (key.escape) return nav.back();
      if (input === 'm') return nav.push('dashboard');
      if (input === ',') return nav.push('settings');
      if (input === 'w' && state.connected) return nav.push('workspace');
      if (input === 'a') setView({ kind: 'form' });
      else if (input === 'c') setView({ kind: 'compass' });
      else if (input === 'v') setView({ kind: 'env-setup' });
      else if (input === 'x' && state.connected) {
        void app.disconnect().then(() => notify('info', 'Disconnected'));
      } else if (highlighted) {
        if (input === 'e') setView({ kind: 'form', editing: highlighted });
        else if (input === 'd' || key.delete) void remove(highlighted);
        else if (input === 'r') void rename(highlighted);
        else if (input === 't') void test(highlighted);
        else if (input === 'f') void app.connections.toggleFavorite(highlighted.id).then(refresh);
        else if (input === 's') {
          void app.connections.setDefault(highlighted.id).then(() => {
            notify('success', `"${highlighted.name}" is the default connection`);
            refresh();
          });
        }
      }
    },
    { isActive: active && view.kind === 'list' },
  );

  if (dialog.open) return <Box justifyContent="center">{dialog.element}</Box>;
  if (busy) return <Loading label={busy} />;

  if (view.kind === 'form') {
    return (
      <ConnectionForm
        editing={view.editing}
        active={active}
        onDone={(saved) => {
          setView({ kind: 'list' });
          if (saved) refresh();
        }}
      />
    );
  }
  if (view.kind === 'compass') {
    return (
      <CompassImport
        active={active}
        onDone={(count) => {
          setView({ kind: 'list' });
          if (count) refresh();
        }}
      />
    );
  }
  if (view.kind === 'env-setup') {
    return (
      <EnvSetup
        active={active}
        onCancel={() => setView({ kind: 'list' })}
        onResults={(connections, secrets, filesRead) =>
          setView({ kind: 'env-results', connections, secrets, filesRead })
        }
      />
    );
  }
  if (view.kind === 'env-results') {
    return (
      <DiscoveredList
        title="Connections found in environment"
        subtitle={view.filesRead.length ? `Read: ${view.filesRead.join(', ')}` : 'Process environment'}
        discovered={view.connections}
        secrets={view.secrets}
        allowSaveSecrets
        active={active}
        onDone={(count) => {
          setView({ kind: 'list' });
          if (count) refresh();
        }}
      />
    );
  }

  if (profiles.loading && !profiles.data) return <Loading label="Loading connections…" />;
  if (profiles.error) return <ErrorBox error={profiles.error} />;
  const list = profiles.data?.list ?? [];
  const defaultId = profiles.data?.defaultId;
  const showBanner = layout.height >= 22;
  const banner = showBanner ? (
    <Box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Text bold color={col(theme, theme.colors.title)}>
        {symbols.unicode ? '◆ ' : ''}MONGO TERMINAL PRO
        <Text color={col(theme, theme.colors.muted)}> · MongoDB management in your terminal</Text>
      </Text>
      <Text color={col(theme, theme.colors.muted)}>Made by Vairag Kakadiya</Text>
    </Box>
  ) : null;

  const quickActions = (
    <Box gap={2} flexShrink={0} flexWrap="wrap">
      <ActionButton k="a" label="New connection" primary />
      <ActionButton k="c" label="Import from Compass" />
      <ActionButton k="v" label="From .env" />
      {state.connected ? <ActionButton k="w" label="Open workspace" /> : null}
      <ActionButton k="m" label="Menu" />
      <ActionButton k="," label="Settings" />
    </Box>
  );

  if (list.length === 0) {
    const choices = [
      {
        key: 'new',
        label: 'New connection',
        value: 'new',
        description: 'Enter a connection string or host/port (local, Atlas, replica set, TLS)',
      },
      {
        key: 'compass',
        label: 'Import from MongoDB Compass',
        value: 'compass',
        description: 'Reads Compass saved connections (read-only)',
      },
      {
        key: 'env',
        label: 'Discover from a project .env file',
        value: 'env',
        description: 'MONGODB_URI, MONGO_URI, DATABASE_URL …',
      },
      {
        key: 'settings',
        label: 'Settings',
        value: 'settings',
        description: 'Theme, limits, credential storage',
      },
      { key: 'help', label: 'Help & keyboard shortcuts', value: 'help' },
    ];
    return (
      <Box flexDirection="column" paddingX={1}>
        {banner}
        <Panel title="Welcome — let's add your first connection" focus>
          <SelectList
            items={choices}
            focus={active}
            height={Math.min(choices.length + 1, layout.height - 6)}
            width={layout.width - 6}
            onSelect={(item) => {
              if (item.value === 'new') setView({ kind: 'form' });
              else if (item.value === 'compass') setView({ kind: 'compass' });
              else if (item.value === 'env') setView({ kind: 'env-setup' });
              else nav.push(item.value as 'settings' | 'help');
            }}
          />
        </Panel>
      </Box>
    );
  }

  const tableWidth = layout.wide ? Math.floor(layout.width * 0.62) : layout.width - 2;
  const detailsPanel = highlighted ? (
    <Panel title="Details" flexGrow={1}>
      <Text bold wrap="truncate-end">
        {highlighted.name}
        {highlighted.id === state.connectionId ? (
          <Text color={col(theme, theme.colors.success)}> {symbols.bullet} connected</Text>
        ) : null}
        {highlighted.id === defaultId ? <Text color={col(theme, theme.colors.muted)}> · default</Text> : null}
      </Text>
      <KV k="URI" v={maskConnectionString(highlighted.uri)} />
      <KV k="Type" v={highlighted.kind} />
      <KV
        k="User"
        v={`${highlighted.username ?? '(none)'}${highlighted.authSource ? ` @ ${highlighted.authSource}` : ''}`}
      />
      <KV
        k="Password"
        v={
          highlighted.username
            ? highlighted.hasStoredPassword
              ? 'stored securely'
              : 'asked when connecting'
            : '—'
        }
      />
      <KV
        k="TLS"
        v={`${highlighted.tls.mode}${highlighted.tls.allowInvalidCertificates ? ' (insecure!)' : ''}`}
      />
      <KV k="Last used" v={highlighted.lastUsedAt ? formatDateTime(highlighted.lastUsedAt) : 'never'} />
      <KV k="Source" v={highlighted.source} />
      {highlighted.production ? (
        <Text color={col(theme, theme.colors.error)}>{symbols.warning} Production connection</Text>
      ) : null}
      {highlighted.readOnlyLocked ? (
        <Text color={col(theme, theme.colors.warning)}>Locked read-only</Text>
      ) : null}
      {highlighted.notes ? <Muted>{truncate(highlighted.notes, 200)}</Muted> : null}
    </Panel>
  ) : null;

  const columns: Column<ConnectionProfile>[] = [
    {
      key: 'mark',
      title: ' ',
      width: 2,
      render: (p) => (p.id === state.connectionId ? symbols.bullet : p.favorite ? symbols.star : ''),
      color: (p) => (p.id === state.connectionId ? theme.colors.success : theme.colors.warning),
    },
    {
      key: 'name',
      title: 'Name',
      minWidth: 14,
      render: (p) => p.name,
      color: (p) => (p.production ? theme.colors.warning : undefined),
    },
    {
      key: 'kind',
      title: 'Type',
      width: 12,
      render: (p) => (p.production ? `${p.kind} PROD` : p.kind),
      priority: 3,
    },
    { key: 'hosts', title: 'Host', minWidth: 14, render: (p) => describeHosts(p.uri), priority: 4 },
    { key: 'user', title: 'User', width: 12, render: (p) => p.username ?? '—', priority: 1 },
    {
      key: 'used',
      title: 'Last used',
      width: 10,
      render: (p) => (p.lastUsedAt ? formatDateTime(p.lastUsedAt).slice(0, 10) : 'never'),
      priority: 2,
    },
  ];

  return (
    <Box flexDirection="column" paddingX={showBanner ? 1 : 0}>
      {banner}
      <Box flexDirection={layout.wide ? 'row' : 'column'}>
        <Panel title={`Connections (${list.length})`} right="Enter to connect" focus width={tableWidth}>
          <DataTable
            columns={columns}
            rows={list}
            rowKey={(p) => p.id}
            focus={active}
            height={Math.max(
              3,
              layout.wide
                ? layout.height - (showBanner ? 9 : 6)
                : Math.min(list.length + 2, layout.height - (showBanner ? 18 : 14)),
            )}
            width={tableWidth - 4}
            initialIndex={Math.max(
              0,
              list.findIndex((p) => p.id === state.connectionId),
            )}
            onHighlight={(p) => setHighlighted(p)}
            onSelect={(p) => void connect(p)}
          />
        </Panel>
        {!layout.compact || layout.wide ? detailsPanel : null}
      </Box>
      {quickActions}
    </Box>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  const { theme } = useUi();
  return (
    <Text wrap="truncate-end">
      <Text color={col(theme, theme.colors.muted)}>{k.padEnd(10)}</Text>
      {v}
    </Text>
  );
}

function ActionButton({ k, label, primary }: { k: string; label: string; primary?: boolean }) {
  const { theme } = useUi();
  return (
    <Text>
      <Text inverse bold color={col(theme, primary ? theme.colors.primary : theme.colors.accent)}>
        {` ${k} `}
      </Text>
      <Text color={col(theme, primary ? theme.colors.primary : theme.colors.text)} bold={primary}>
        {` ${label}`}
      </Text>
    </Text>
  );
}

function CompassImport({ active, onDone }: { active: boolean; onDone(imported: number): void }) {
  const result = useAsync<CompassDiscoveryResult>(() => discoverCompassConnections(), []);
  useInput(
    (_i, key) => {
      if (key.escape && (result.loading || result.error)) onDone(0);
    },
    { isActive: active && (result.loading || Boolean(result.error)) },
  );
  if (result.loading) return <Loading label="Looking for MongoDB Compass connections…" />;
  if (result.error) return <ErrorBox error={result.error} />;
  const r = result.data as CompassDiscoveryResult;
  const subtitle = !r.installed
    ? 'MongoDB Compass was not found for this user.'
    : r.installations
        .map((i) => `${i.variant}${i.version ? ` ${i.version}` : ''}: ${i.connectionFiles} file(s)`)
        .join(' · ');
  return (
    <DiscoveredList
      title="MongoDB Compass connections"
      subtitle={[subtitle, ...r.warnings].join('\n')}
      discovered={r.connections}
      secrets={new Map()}
      active={active}
      onDone={onDone}
    />
  );
}

function DiscoveredList({
  title,
  subtitle,
  discovered,
  secrets,
  active,
  onDone,
  allowSaveSecrets,
}: {
  title: string;
  subtitle: string;
  discovered: DiscoveredConnection[];
  secrets: Map<string, string>;
  active: boolean;
  onDone(n: number): void;
  allowSaveSecrets?: boolean;
}) {
  const { app, theme, symbols, notify, notifyError } = useUi();
  const layout = useLayout();
  const existing = useAsync(() => app.connections.list(), []);
  const marked = useMemo(
    () => (existing.data ? markExisting(discovered, existing.data) : []),
    [existing.data, discovered],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saveSecrets, setSaveSecrets] = useState(true);
  const [highlight, setHighlight] = useState<string | undefined>();
  const [importing, setImporting] = useState(false);
  const initialised = useRef(false);

  useEffect(() => {
    if (!initialised.current && existing.data) {
      initialised.current = true;
      setSelected(new Set(marked.filter((m) => !m.alreadySaved).map((m) => m.key)));
    }
  }, [existing.data, marked]);

  useHints(
    [
      { key: 'Space', label: 'toggle' },
      { key: 'A', label: 'all/none' },
      { key: 'Enter', label: 'import selected' },
      ...(allowSaveSecrets ? [{ key: 'p', label: 'save passwords' }] : []),
      { key: 'Esc', label: 'cancel' },
    ],
    [allowSaveSecrets],
  );

  const doImport = async () => {
    const chosen = marked.filter((m) => selected.has(m.key));
    if (chosen.length === 0) {
      notify('warning', 'Nothing selected');
      return;
    }
    setImporting(true);
    try {
      const outcome = await importDiscovered(
        app.connections,
        chosen,
        secrets,
        Boolean(allowSaveSecrets && saveSecrets),
      );
      notify(
        'success',
        `Imported ${outcome.imported.length} connection(s)`,
        outcome.needPassword.length
          ? `Password will be requested for: ${outcome.needPassword.map((p) => p.name).join(', ')}`
          : undefined,
      );
      onDone(outcome.imported.length);
    } catch (e) {
      notifyError(e, 'Import failed');
      setImporting(false);
    }
  };

  useInput(
    (input, key) => {
      if (key.escape) return onDone(0);
      if (input === ' ' && highlight) {
        setSelected((s) => {
          const n = new Set(s);
          if (n.has(highlight)) n.delete(highlight);
          else n.add(highlight);
          return n;
        });
      } else if (input === 'A')
        setSelected((s) =>
          s.size > 0 ? new Set() : new Set(marked.filter((m) => !m.alreadySaved).map((m) => m.key)),
        );
      else if (input === 'p' && allowSaveSecrets) setSaveSecrets((v) => !v);
    },
    { isActive: active && !importing },
  );

  if (importing) return <Loading label="Importing…" />;
  if (existing.loading) return <Loading />;
  const current = marked.find((m) => m.key === highlight);
  return (
    <Panel title={title} focus>
      {subtitle
        .split('\n')
        .filter(Boolean)
        .map((l, i) => (
          <Muted key={i}>{truncate(l, layout.width - 6)}</Muted>
        ))}
      {marked.length === 0 ? (
        <Text>No connections found. Press Esc to go back.</Text>
      ) : (
        <SelectList
          items={marked.map((m) => ({
            key: m.key,
            label: `${selected.has(m.key) ? symbols.checkboxOn : symbols.checkboxOff} ${m.name}`,
            value: m,
            hint: m.alreadySaved ? 'already saved' : m.passwordRequired ? 'needs password' : '',
            disabled: m.alreadySaved,
            disabledReason: 'already saved',
          }))}
          focus={active}
          height={Math.max(3, layout.height - 9)}
          width={layout.width - 6}
          showDescription={false}
          onHighlight={(item) => setHighlight(item?.key)}
          onSelect={() => void doImport()}
        />
      )}
      {current ? (
        <Box flexDirection="column">
          <Text color={col(theme, theme.colors.muted)} wrap="truncate-end">
            {current.displayUri}
          </Text>
          {current.notes.map((n, i) => (
            <Text key={i} color={col(theme, theme.colors.muted)} wrap="truncate-end">
              {symbols.info} {n}
            </Text>
          ))}
        </Box>
      ) : null}
      {allowSaveSecrets ? (
        <Text>
          {saveSecrets ? symbols.checkboxOn : symbols.checkboxOff} Store found passwords in secure credential
          storage (p)
        </Text>
      ) : null}
      <Muted>
        Credentials are never displayed. Compass-encrypted passwords are not decrypted; you will be asked for
        them.
      </Muted>
    </Panel>
  );
}

function EnvSetup({
  active,
  onCancel,
  onResults,
}: {
  active: boolean;
  onCancel(): void;
  onResults(c: DiscoveredConnection[], s: Map<string, string>, files: string[]): void;
}) {
  const { notifyError } = useUi();
  const layout = useLayout();
  const [values, setValues] = useState<Record<string, unknown>>({
    directory: process.cwd(),
    includeProcessEnv: false,
    consent: false,
  });
  const [scanning, setScanning] = useState(false);
  const scan = async () => {
    if (!values.consent) {
      notifyError(new Error('Please confirm permission to read the files first'), 'Permission required');
      return;
    }
    setScanning(true);
    try {
      const fromDir = String(values.directory ?? '').trim()
        ? await collectFromProjectDirectory(String(values.directory))
        : { candidates: [], filesRead: [], warnings: [] };
      const candidates = [
        ...fromDir.candidates,
        ...(values.includeProcessEnv ? collectFromEnvironment() : []),
      ];
      const { connections, secrets } = candidatesToConnections(candidates);
      onResults(connections, secrets, fromDir.filesRead);
    } catch (e) {
      notifyError(e, 'Scan failed');
      setScanning(false);
    }
  };
  if (scanning) return <Loading label="Reading environment files…" />;
  return (
    <Panel title="Discover connections from a project" focus>
      <Muted>
        Reads only these files in the chosen directory (not recursive): .env, .env.local, .env.development,
        .env.test, .env.production …
      </Muted>
      <Muted>
        Looks for MONGODB_URI, MONGO_URI, MONGODB_URL, DATABASE_URL and similar. Nothing is executed and
        values are never displayed.
      </Muted>
      <Box marginTop={1}>
        <Form
          fields={[
            { key: 'directory', label: 'Project directory', kind: 'text' },
            { key: 'includeProcessEnv', label: "Also check this shell's environment", kind: 'toggle' },
            { key: 'consent', label: 'I allow reading these files', kind: 'toggle' },
          ]}
          values={values}
          onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))}
          focus={active}
          width={layout.width - 6}
          onCancel={onCancel}
          actions={[
            { key: 'scan', label: 'Scan', tone: 'primary', onPress: () => void scan() },
            { key: 'cancel', label: 'Cancel', onPress: onCancel },
          ]}
        />
      </Box>
    </Panel>
  );
}
