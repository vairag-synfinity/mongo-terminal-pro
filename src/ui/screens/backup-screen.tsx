import { Box, Text, useInput } from 'ink';
import React, { useRef, useState } from 'react';
import type { BackupRecord } from '../../backup/backup-history.js';
import { BackupManager, type BackupResult } from '../../backup/backup-manager.js';
import { detectTools, installInstructions, type ToolInfo } from '../../backup/database-tools.js';
import {
  checkCollisions,
  inspectBackup,
  RestoreManager,
  type BackupInspection,
  type CollisionReport,
  type RestoreResult,
} from '../../backup/restore-manager.js';
import { Operations } from '../../security/permission-manager.js';
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  truncate,
} from '../../utils/formatting.js';
import { DataTable } from '../components/data-table.js';
import { useDialog } from '../components/dialog.js';
import { ErrorBox, Loading, Muted } from '../components/feedback.js';
import { FileBrowser } from '../components/file-browser.js';
import { Form } from '../components/form.js';
import { Panel } from '../components/panel.js';
import { ScrollText } from '../components/scroll-text.js';
import { cleanDroppedPath } from '../components/text-input.js';
import { useAppState, useScreenActive, useUi } from '../context.js';
import { useAsync } from '../hooks/use-async.js';
import { useDraft } from '../hooks/use-draft.js';
import { useNamespaceSuggestions } from '../hooks/use-namespaces.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';
import { confirmOperation } from './confirm-operation.js';

type Tab = 'backup' | 'restore' | 'history' | 'tools';
const TABS: Tab[] = ['backup', 'restore', 'history', 'tools'];
const TAB_LABELS: Record<Tab, string> = {
  backup: '1 Backup',
  restore: '2 Restore',
  history: '3 History',
  tools: '4 Tools',
};

export function BackupScreen({ params }: { params: { db?: string } }) {
  const { app, nav, theme, settings, symbols, notify, notifyError } = useUi();
  const state = useAppState();
  const screenActive = useScreenActive();
  const layout = useLayout();
  const dialog = useDialog(layout.width);
  const [tab, setTab] = useState<Tab>('backup');
  const [phase, setPhase] = useState<
    'form' | 'browse-out' | 'browse-dir' | 'browse-file' | 'running' | 'result' | 'restore-review'
  >('form');
  const [log, setLog] = useState<string[]>([]);
  const [backupResult, setBackupResult] = useState<BackupResult | undefined>();
  const [restoreResult, setRestoreResult] = useState<RestoreResult | undefined>();
  const [inspection, setInspection] = useState<
    { info: BackupInspection; collisions: CollisionReport[] } | undefined
  >();
  const [historyTick, setHistoryTick] = useState(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const tools = useAsync<ToolInfo[]>(() => detectTools(), []);
  const history = useAsync<BackupRecord[]>(() => app.backupHistory.list(), [historyTick, tab]);
  const [backupForm, setBackupForm] = useDraft('backup:form', () => ({
    database: params.db ?? state.database ?? '',
    collection: '',
    gzip: true,
    archive: false,
    outputDir: settings.defaultBackupDir || app.paths.backupsDir,
  }));
  const [restoreForm, setRestoreForm] = useDraft('restore:form', () => ({
    path: '',
    drop: false,
    fromDb: '',
    toDb: '',
    dryRun: false,
    nsInclude: '',
  }));
  const ns = useNamespaceSuggestions(backupForm.database);
  const active = screenActive && !dialog.open;
  const busy = phase === 'running';

  const toolsFound = (name: string) => Boolean(tools.data?.find((t) => t.name === name)?.path);
  const profile = app.connectionManager.activeProfile;
  const password = async () =>
    profile?.username ? app.connections.getPassword(profile.id).catch(() => undefined) : undefined;
  const appendLog = (line: string) => setLog((l) => [...l.slice(-500), line]);

  const runBackup = async () => {
    if (!profile) return;
    const ac = new AbortController();
    abort.current = ac;
    setLog([]);
    setPhase('running');
    try {
      const manager = new BackupManager(app.backupHistory);
      const result = await manager.run(profile, await password(), {
        database: backupForm.database.trim() || undefined,
        collection: backupForm.collection.trim() || undefined,
        gzip: backupForm.gzip,
        archive: backupForm.archive,
        outputDir: cleanDroppedPath(backupForm.outputDir),
        signal: ac.signal,
        onOutput: appendLog,
      });
      setBackupResult(result);
      setPhase('result');
      setHistoryTick((t) => t + 1);
      if (result.success) notify('success', 'Backup verified', result.verification?.summary);
      else notify('error', `Backup ${result.record.status}`, result.record.error);
    } catch (e) {
      notifyError(e, 'Backup failed');
      setPhase('form');
    }
  };

  const reviewRestore = async () => {
    if (!restoreForm.path.trim()) return notify('warning', 'Choose a backup first');
    try {
      const info = await inspectBackup(cleanDroppedPath(restoreForm.path));
      const collisions =
        info.layout === 'directory'
          ? await checkCollisions(app.connectionManager.getClient(), info, {
              fromDatabase: restoreForm.fromDb || undefined,
              toDatabase: restoreForm.toDb || undefined,
            })
          : [];
      setInspection({ info, collisions });
      setPhase('restore-review');
    } catch (e) {
      notifyError(e, 'Cannot read backup');
    }
  };

  const runRestore = async () => {
    if (!profile || !inspection) return;
    const existing = inspection.collisions.filter((c) => c.exists);
    if (!restoreForm.dryRun) {
      const op = restoreForm.drop ? Operations.restoreDrop : Operations.restore;
      const ok = await confirmOperation(
        { app, dialog, notify },
        op,
        `Restore ${inspection.info.path} into "${profile.name}"?`,
        [
          ...(existing.length
            ? [
                restoreForm.drop
                  ? `${existing.length} existing collection(s) will be DROPPED and replaced.`
                  : `${existing.length} collection(s) already exist; documents with an existing _id will fail (data kept).`,
              ]
            : []),
          ...(inspection.info.layout === 'archive'
            ? ['Archive contents are only listed during the restore.']
            : []),
        ],
        true,
      );
      if (!ok) return;
    }
    const ac = new AbortController();
    abort.current = ac;
    setLog([]);
    setPhase('running');
    try {
      const manager = new RestoreManager(app.backupHistory, app.permissions);
      const result = await manager.run(profile, await password(), {
        path: inspection.info.path,
        drop: restoreForm.drop,
        dryRun: restoreForm.dryRun,
        fromDatabase: restoreForm.fromDb || undefined,
        toDatabase: restoreForm.toDb || undefined,
        nsInclude: restoreForm.nsInclude
          ? restoreForm.nsInclude
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
        signal: ac.signal,
        onOutput: appendLog,
      });
      setRestoreResult(result);
      setPhase('result');
      setHistoryTick((t) => t + 1);
      app.events.emit('metadata:invalidated', {});
      if (result.success) notify('success', 'Restore finished', result.record.verificationSummary);
      else notify('error', 'Restore failed', result.record.error);
    } catch (e) {
      notifyError(e, 'Restore failed');
      setPhase('form');
    }
  };

  useHints(
    busy
      ? [{ key: 'Esc', label: 'cancel' }]
      : phase === 'form' && (tab === 'history' || tab === 'tools')
        ? [
            { key: '1-4/←→', label: 'tabs' },
            ...(tab === 'history'
              ? [{ key: 'Enter', label: 'restore this' }]
              : [{ key: 'r', label: 're-check' }]),
            { key: 'Esc', label: 'back' },
          ]
        : [{ key: 'Esc', label: 'back' }],
    [busy, phase, tab],
  );

  useInput(
    (input, key) => {
      if (busy) {
        if (key.escape) abort.current?.abort();
        return;
      }
      if (phase === 'result' || phase === 'restore-review') {
        if (key.escape || (phase === 'result' && key.return)) setPhase('form');
        if (phase === 'restore-review' && key.return) void runRestore();
        return;
      }
      if (phase !== 'form') return;
      if (tab === 'history' || tab === 'tools') {
        if (key.escape) return nav.back();
        if (key.leftArrow || key.rightArrow)
          setTab(
            (t) => TABS[(TABS.indexOf(t) + (key.leftArrow ? -1 : 1) + TABS.length) % TABS.length] as Tab,
          );
        if (/^[1-4]$/.test(input)) setTab(TABS[Number(input) - 1] as Tab);
        if (tab === 'tools' && input === 'r') tools.reload();
      }
    },
    { isActive: active },
  );

  if (dialog.open) return <Box justifyContent="center">{dialog.element}</Box>;
  const tabBar = (
    <Box gap={2}>
      {TABS.map((t) => (
        <Text
          key={t}
          bold={t === tab}
          inverse={t === tab}
          color={col(theme, t === tab ? theme.colors.primary : theme.colors.muted)}
        >
          {` ${TAB_LABELS[t]} `}
        </Text>
      ))}
      <Muted>(switch with the buttons below, or 1-4 / ←→ on History and Tools)</Muted>
    </Box>
  );
  const bodyHeight = layout.height - 4;

  if (phase === 'browse-out' || phase === 'browse-dir' || phase === 'browse-file') {
    return (
      <Panel
        title={
          phase === 'browse-out'
            ? 'Choose backup folder'
            : phase === 'browse-dir'
              ? 'Choose dump directory (contains database folders)'
              : 'Choose archive file'
        }
        focus
      >
        <FileBrowser
          initialDir={phase === 'browse-out' ? backupForm.outputDir : app.paths.backupsDir}
          mode={phase === 'browse-file' ? 'file' : 'directory'}
          extensions={phase === 'browse-file' ? ['.archive', '.gz', '.archive.gz'] : undefined}
          focus={active}
          height={bodyHeight}
          width={layout.width - 4}
          onPick={(p) => {
            if (phase === 'browse-out') setBackupForm((f) => ({ ...f, outputDir: p }));
            else setRestoreForm((f) => ({ ...f, path: p }));
            setPhase('form');
          }}
          onCancel={() => setPhase('form')}
        />
      </Panel>
    );
  }

  if (busy) {
    return (
      <Panel title={tab === 'backup' ? 'mongodump running…' : 'mongorestore running…'} focus>
        <Loading
          label={log[log.length - 1] ? truncate(log[log.length - 1] ?? '', layout.width - 20) : 'Starting…'}
        />
        <ScrollText lines={log} height={bodyHeight - 2} width={layout.width - 4} focus={false} follow />
      </Panel>
    );
  }

  if (phase === 'result') {
    if (tab === 'backup' && backupResult) {
      const v = backupResult.verification;
      return (
        <Panel title="Backup result" focus>
          <Text bold color={col(theme, backupResult.success ? theme.colors.success : theme.colors.error)}>
            {backupResult.success ? symbols.check : symbols.cross}{' '}
            {backupResult.success ? 'Backup completed and verified' : `Backup ${backupResult.record.status}`}
          </Text>
          <Text wrap="truncate-end">Location: {backupResult.path}</Text>
          {v ? (
            <Text>
              {v.summary} · {formatBytes(v.sizeBytes)}
            </Text>
          ) : null}
          {backupResult.record.error ? (
            <Text color={col(theme, theme.colors.error)} wrap="wrap">
              {backupResult.record.error}
            </Text>
          ) : null}
          {v && v.namespaces.length ? (
            <DataTable
              columns={[
                { key: 'ns', title: 'Namespace', render: (n) => n.namespace },
                {
                  key: 'docs',
                  title: 'Documents',
                  width: 12,
                  align: 'right',
                  render: (n) => formatNumber(n.documents),
                },
                {
                  key: 'status',
                  title: 'Status',
                  width: 30,
                  render: (n) => (n.ok ? 'ok' : (n.error ?? 'failed')),
                  color: (n) => (n.ok ? theme.colors.success : theme.colors.error),
                },
              ]}
              rows={v.namespaces}
              rowKey={(n) => n.namespace}
              focus={active}
              height={bodyHeight - 5}
              width={layout.width - 4}
            />
          ) : null}
          <Muted>Enter/Esc to continue</Muted>
        </Panel>
      );
    }
    if (tab === 'restore' && restoreResult) {
      return (
        <Panel title="Restore result" focus>
          <Text bold color={col(theme, restoreResult.success ? theme.colors.success : theme.colors.error)}>
            {restoreResult.success ? symbols.check : symbols.cross}{' '}
            {restoreResult.success
              ? `Restore finished${restoreForm.dryRun ? ' (dry run)' : ''}`
              : 'Restore failed'}
          </Text>
          {restoreResult.record.verificationSummary ? (
            <Text>{restoreResult.record.verificationSummary}</Text>
          ) : null}
          {restoreResult.record.error ? (
            <Text color={col(theme, theme.colors.error)} wrap="wrap">
              {restoreResult.record.error}
            </Text>
          ) : null}
          <ScrollText lines={log} height={bodyHeight - 4} width={layout.width - 4} focus={active} follow />
        </Panel>
      );
    }
  }

  if (phase === 'restore-review' && inspection) {
    const existing = inspection.collisions.filter((c) => c.exists);
    return (
      <Panel title={`Review restore · ${truncate(inspection.info.path, 60)}`} focus>
        <Text>
          Layout: {inspection.info.layout}
          {inspection.info.gzip ? ' (gzip)' : ''} · target connection: <Text bold>{profile?.name}</Text>
          {restoreForm.dryRun ? ' · DRY RUN' : ''}
        </Text>
        {existing.length ? (
          <Text color={col(theme, theme.colors.warning)} wrap="wrap">
            {symbols.warning} {existing.length} namespace collision(s).{' '}
            {restoreForm.drop
              ? 'These collections will be DROPPED before restoring.'
              : 'Existing documents are kept; duplicates fail.'}
          </Text>
        ) : null}
        {inspection.info.layout === 'directory' ? (
          <DataTable
            columns={[
              { key: 'src', title: 'Source', render: (c) => c.namespace },
              { key: 'dst', title: 'Target', render: (c) => c.targetNamespace },
              {
                key: 'exists',
                title: 'Exists',
                width: 22,
                render: (c) => (c.exists ? `yes (~${formatNumber(c.estimatedDocuments)} docs)` : 'no'),
                color: (c) => (c.exists ? theme.colors.warning : undefined),
              },
            ]}
            rows={inspection.collisions}
            rowKey={(c) => c.namespace}
            focus={active}
            height={bodyHeight - 5}
            width={layout.width - 4}
          />
        ) : (
          <Muted>Archive backups list their namespaces while restoring.</Muted>
        )}
        <Text color={col(theme, theme.colors.accent)}>Enter = start restore · Esc = back</Text>
      </Panel>
    );
  }

  // phase === 'form'
  let body: React.ReactNode;
  if (tab === 'backup') {
    body = !toolsFound('mongodump') ? (
      <ToolsMissing tools={tools.data} />
    ) : (
      <Form
        fields={[
          {
            key: 'database',
            label: 'Database',
            kind: 'combo',
            suggestions: ns.databases,
            suggestionsLoading: ns.loadingDatabases,
            newValueLabel: 'not found',
            placeholder: '(all databases)',
          },
          {
            key: 'collection',
            label: 'Collection',
            kind: 'combo',
            suggestions: ns.collections,
            suggestionsLoading: ns.loadingCollections,
            newValueLabel: 'not found',
            placeholder: '(all collections)',
          },
          { key: 'gzip', label: 'Compress (gzip)', kind: 'toggle' },
          {
            key: 'archive',
            label: 'Single archive file',
            kind: 'toggle',
            help: 'Off = directory of .bson files (verifiable per collection)',
          },
          { key: 'outputDir', label: 'Backup folder', kind: 'text' },
        ]}
        values={backupForm as unknown as Record<string, unknown>}
        onChange={(k, v) => setBackupForm((f) => ({ ...f, [k]: v }))}
        focus={active}
        width={layout.width - 4}
        onCancel={() => nav.back()}
        actions={[
          { key: 'run', label: 'Start backup', tone: 'primary', onPress: () => void runBackup() },
          { key: 'browse', label: 'Choose folder…', onPress: () => setPhase('browse-out') },
          { key: 'next', label: 'Restore tab', onPress: () => setTab('restore') },
          { key: 'back', label: 'Back', onPress: () => nav.back() },
        ]}
        footer={
          <Muted>
            Uses mongodump; credentials go through a temporary private config file, never the command line.
            Success is reported only after verification.
          </Muted>
        }
      />
    );
  } else if (tab === 'restore') {
    body = !toolsFound('mongorestore') ? (
      <ToolsMissing tools={tools.data} />
    ) : (
      <Form
        fields={[
          {
            key: 'path',
            label: 'Backup path',
            kind: 'text',
            placeholder: 'dump directory or .archive(.gz) file',
          },
          {
            key: 'nsInclude',
            label: 'Only namespaces',
            kind: 'text',
            placeholder: 'e.g. shop.users, shop.*',
          },
          { key: 'fromDb', label: 'Rename: from db', kind: 'text' },
          {
            key: 'toDb',
            label: 'Rename: to db',
            kind: 'combo',
            suggestions: ns.databases,
            newValueLabel: 'new database',
          },
          {
            key: 'drop',
            label: 'Drop existing first',
            kind: 'toggle',
            help: 'DESTRUCTIVE: replaces existing collections',
          },
          { key: 'dryRun', label: 'Dry run', kind: 'toggle' },
        ]}
        values={restoreForm as unknown as Record<string, unknown>}
        onChange={(k, v) =>
          setRestoreForm((f) => ({ ...f, [k]: k === 'path' ? cleanDroppedPath(String(v)) : v }))
        }
        focus={active}
        width={layout.width - 4}
        onCancel={() => nav.back()}
        actions={[
          {
            key: 'review',
            label: 'Review & restore',
            tone: restoreForm.drop ? 'danger' : 'primary',
            onPress: () => void reviewRestore(),
          },
          { key: 'dir', label: 'Browse dump dir…', onPress: () => setPhase('browse-dir') },
          { key: 'file', label: 'Browse archive…', onPress: () => setPhase('browse-file') },
          { key: 'next', label: 'History tab', onPress: () => setTab('history') },
        ]}
        footer={
          !state.writeEnabled && !restoreForm.dryRun ? (
            <Text color={col(theme, theme.colors.warning)}>
              {symbols.warning} Read-only session: press W to enable writes (dry run works without).
            </Text>
          ) : undefined
        }
      />
    );
  } else if (tab === 'history') {
    if (history.loading && !history.data) body = <Loading />;
    else if (history.error) body = <ErrorBox error={history.error} />;
    else
      body = (
        <DataTable
          columns={[
            { key: 'when', title: 'When', width: 19, render: (r) => formatDateTime(r.createdAt) },
            { key: 'kind', title: 'Kind', width: 7, render: (r) => r.kind },
            { key: 'conn', title: 'Connection', minWidth: 10, render: (r) => r.connectionName, priority: 2 },
            {
              key: 'scope',
              title: 'Scope',
              minWidth: 10,
              render: (r) => [r.database ?? 'all', r.collection].filter(Boolean).join('.'),
            },
            {
              key: 'status',
              title: 'Status',
              width: 19,
              render: (r) => r.status,
              color: (r) => (r.status === 'success' ? theme.colors.success : theme.colors.error),
            },
            {
              key: 'size',
              title: 'Size',
              width: 9,
              align: 'right',
              render: (r) => formatBytes(r.sizeBytes),
              priority: 1,
            },
            {
              key: 'dur',
              title: 'Time',
              width: 8,
              align: 'right',
              render: (r) => formatDuration(r.durationMs),
              priority: 0,
            },
          ]}
          rows={history.data ?? []}
          rowKey={(r) => r.id}
          focus={active}
          height={bodyHeight - 1}
          width={layout.width - 4}
          emptyText="No backups or restores yet"
          onSelect={(r) => {
            if (r.kind !== 'backup' || r.status !== 'success')
              return notify('info', 'Only successful backups can be restored from here');
            setRestoreForm((f) => ({ ...f, path: r.path }));
            setTab('restore');
          }}
        />
      );
  } else {
    body = <ToolsMissing tools={tools.data} showAll />;
  }

  return (
    <Panel title="Backup / Restore" right={profile ? profile.name : undefined} focus>
      {tabBar}
      {tools.loading ? <Loading label="Checking MongoDB Database Tools…" /> : body}
    </Panel>
  );
}

function ToolsMissing({ tools, showAll }: { tools?: ToolInfo[]; showAll?: boolean }) {
  const { theme, symbols } = useUi();
  const missing = (tools ?? []).filter((t) => !t.path);
  return (
    <Box flexDirection="column">
      {(tools ?? []).map((t) => (
        <Text key={t.name}>
          <Text color={col(theme, t.path ? theme.colors.success : theme.colors.error)}>
            {t.path ? symbols.check : symbols.cross}
          </Text>{' '}
          {t.name.padEnd(13)} {t.path ? `${t.version ?? '?'}  ${t.path}` : 'not found'}
        </Text>
      ))}
      {missing.length > 0 || showAll ? (
        <Box flexDirection="column" marginTop={1}>
          {missing.length > 0 ? (
            <Text color={col(theme, theme.colors.warning)}>
              {symbols.warning} Some MongoDB Database Tools are missing.
            </Text>
          ) : null}
          {installInstructions().map((l, i) => (
            <Text key={i} color={col(theme, theme.colors.muted)} wrap="wrap">
              {l}
            </Text>
          ))}
          <Text color={col(theme, theme.colors.muted)}>
            Custom locations: set MTP_MONGODUMP_PATH / MTP_MONGORESTORE_PATH.
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
