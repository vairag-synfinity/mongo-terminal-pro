import { Box, Text, useInput } from 'ink';
import type { MongoClient } from 'mongodb';
import React, { useEffect, useRef, useState } from 'react';
import { needsPassword } from '../../connection/connection-manager.js';
import type { ConnectionProfile } from '../../connection/connection-types.js';
import { Operations } from '../../security/permission-manager.js';
import {
  CopyManager,
  listSourceCollections,
  listUserDatabases,
  type CopyDuplicates,
  type CopySummary,
} from '../../transfer/copy-manager.js';
import { progressFraction, type TransferProgress } from '../../transfer/transfer-progress.js';
import { formatDuration, formatNumber, truncate } from '../../utils/formatting.js';
import { DataTable } from '../components/data-table.js';
import { useDialog } from '../components/dialog.js';
import { Loading, Muted, ProgressBar } from '../components/feedback.js';
import { Form } from '../components/form.js';
import { Panel } from '../components/panel.js';
import { SelectList } from '../components/select-list.js';
import { useAppState, useScreenActive, useUi } from '../context.js';
import { useAsync } from '../hooks/use-async.js';
import { useNamespaceSuggestions } from '../hooks/use-namespaces.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';
import { confirmOperation } from './confirm-operation.js';

interface CopyForm {
  scope: 'database' | 'all';
  sourceDb: string;
  which: 'all' | 'choose';
  targetId: string;
  targetDb: string;
  drop: boolean;
  duplicates: CopyDuplicates;
  indexes: boolean;
  views: boolean;
  batchSize: string;
}

type Step = 'form' | 'collections' | 'running' | 'done';

/**
 * Copy / migrate: one database (all or selected collections) or every database, into another
 * database on the same server or into another saved connection.
 */
export function CopyScreen({ params }: { params: { db?: string } }) {
  const { app, nav, theme, symbols, settings, notify, notifyError } = useUi();
  const state = useAppState();
  const screenActive = useScreenActive();
  const layout = useLayout();
  const dialog = useDialog(layout.width);
  const [form, setForm] = useState<CopyForm>(() => ({
    scope: 'database',
    sourceDb: params.db ?? state.database ?? '',
    which: 'all',
    targetId: state.connectionId ?? '',
    targetDb: params.db ? `${params.db}_copy` : '',
    drop: false,
    duplicates: 'abort',
    indexes: true,
    views: true,
    batchSize: String(settings.importBatchSize),
  }));
  const [step, setStep] = useState<Step>('form');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [highlight, setHighlight] = useState<string | undefined>();
  const [progress, setProgress] = useState<{ db: string; p?: TransferProgress } | undefined>();
  const [results, setResults] = useState<CopySummary[]>([]);
  const targetClient = useRef<{ id: string; client: MongoClient } | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  const active = screenActive && !dialog.open;

  const ns = useNamespaceSuggestions(form.sourceDb);
  const profiles = useAsync(() => app.connections.list(), []);
  const sourceProfile = app.connectionManager.activeProfile;
  const target = profiles.data?.find((p) => p.id === form.targetId);
  const sameConnection = Boolean(target && sourceProfile && target.id === sourceProfile.id);
  const sourceCollections = useAsync(
    () => listSourceCollections(app.connectionManager.getClient(), form.sourceDb),
    [form.sourceDb],
    { enabled: state.connected && ns.databases.includes(form.sourceDb) },
  );

  useEffect(
    () => () => {
      void targetClient.current?.client.close().catch(() => undefined);
    },
    [],
  );

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }) as CopyForm);

  /** Client for the target (the active one, or a secondary client that is kept for this screen). */
  const getTargetClient = async (profile: ConnectionProfile): Promise<MongoClient | undefined> => {
    if (sourceProfile && profile.id === sourceProfile.id) return app.connectionManager.getClient();
    if (targetClient.current?.id === profile.id) return targetClient.current.client;
    await targetClient.current?.client.close().catch(() => undefined);
    let password: string | undefined;
    if (profile.username && needsPassword(profile)) {
      password = await app.connections.getPassword(profile.id).catch(() => undefined);
      if (password === undefined) {
        password = await dialog.prompt({
          title: `Password for ${profile.username}@${profile.name} (target)`,
          label: 'Password:',
          mask: true,
        });
        if (password === undefined) return undefined;
      }
    }
    const client = await app.openSecondaryClient(profile, password);
    targetClient.current = { id: profile.id, client };
    return client;
  };

  const run = async () => {
    if (!target || !sourceProfile) return notify('warning', 'Choose a target connection');
    if (form.scope === 'database' && !ns.databases.includes(form.sourceDb))
      return notify('warning', 'Choose an existing source database');
    if (form.scope === 'all' && sameConnection)
      return notify('warning', 'Copying all databases needs another target connection');
    const targetDb = form.targetDb.trim() || form.sourceDb;
    if (form.scope === 'database' && sameConnection && targetDb === form.sourceDb)
      return notify('warning', 'Choose a different target database on the same connection');
    if (form.which === 'choose' && form.scope === 'database' && chosen.size === 0)
      return notify('warning', 'Select at least one collection');

    const op = form.drop
      ? Operations.copyDrop
      : form.duplicates === 'replace'
        ? Operations.copyReplace
        : Operations.copyData;
    const what =
      form.scope === 'all'
        ? `all databases of "${sourceProfile.name}"`
        : `${form.sourceDb}${form.which === 'choose' ? ` (${chosen.size} collection(s))` : ' (all collections)'}`;
    const detail = `Copy ${what} → "${target.name}"${form.scope === 'all' ? '' : ` › ${targetDb}`}?`;
    const extra = [
      form.drop
        ? 'Existing target collections with the same names will be DROPPED first.'
        : form.duplicates === 'replace'
          ? 'Target documents with the same _id will be REPLACED.'
          : form.duplicates === 'skip'
            ? 'Documents whose _id already exists in the target are skipped.'
            : 'The copy stops at the first _id that already exists in the target.',
    ];
    let ok: boolean;
    if (sameConnection) {
      ok = await confirmOperation({ app, dialog, notify }, op, detail, extra, true);
    } else {
      const decision = app.permissions.checkTarget(op, target);
      if (!decision.allowed) {
        notify('error', 'Not allowed', decision.reason);
        return;
      }
      ok = await dialog.confirm({
        title: op.name,
        message: [
          detail,
          ...extra,
          ...(target.production ? [`Target "${target.name}" is marked as PRODUCTION.`] : []),
        ],
        danger: op.risk === 'destructive' || target.production,
        confirmLabel: 'Copy',
        typeToConfirm: decision.confirmation === 'type-name' ? target.name : undefined,
      });
    }
    if (!ok) return;

    let client: MongoClient | undefined;
    try {
      client = await getTargetClient(target);
    } catch (e) {
      notifyError(e, `Could not connect to ${target.name}`);
      return;
    }
    if (!client) return;
    const ac = new AbortController();
    abort.current = ac;
    setResults([]);
    setStep('running');
    try {
      const sourceClient = app.connectionManager.getClient();
      const dbs = form.scope === 'all' ? await listUserDatabases(sourceClient) : [form.sourceDb];
      const done: CopySummary[] = [];
      for (const db of dbs) {
        if (ac.signal.aborted) break;
        setProgress({ db });
        const toDb = form.scope === 'all' ? db : targetDb;
        const summary = await new CopyManager().run({
          source: { client: sourceClient, database: db, label: `${sourceProfile.name} › ${db}` },
          target: { client, database: toDb, label: `${target.name} › ${toDb}` },
          collections: form.scope === 'database' && form.which === 'choose' ? [...chosen] : undefined,
          includeViews: form.views,
          copyIndexes: form.indexes,
          dropTarget: form.drop,
          duplicates: form.duplicates,
          batchSize: Math.max(1, Number(form.batchSize) || settings.importBatchSize),
          signal: ac.signal,
          onProgress: (p) => setProgress({ db, p }),
        });
        done.push(summary);
        setResults([...done]);
        if (summary.aborted) break;
      }
      if (sameConnection) app.events.emit('metadata:invalidated', {});
      setStep('done');
    } catch (e) {
      notifyError(e, 'Copy failed');
      setStep('form');
    }
  };

  useHints(
    step === 'running'
      ? [{ key: 'Esc', label: 'cancel' }]
      : step === 'done'
        ? [{ key: 'Enter', label: 'done' }]
        : step === 'collections'
          ? [
              { key: 'Space', label: 'toggle' },
              { key: 'A', label: 'all/none' },
              { key: 'Enter', label: 'use selection' },
              { key: 'Esc', label: 'back' },
            ]
          : [
              { key: 'Tab', label: 'next field' },
              { key: 'Ctrl+S', label: 'copy' },
              { key: 'Esc', label: 'back' },
            ],
    [step],
  );

  useInput(
    (input, key) => {
      if (step === 'running' && key.escape) abort.current?.abort();
      else if (step === 'done' && (key.return || key.escape)) setStep('form');
      else if (step === 'collections') {
        const names = (sourceCollections.data ?? []).map((c) => c.name);
        if (key.escape || key.return) setStep('form');
        else if (input === ' ' && highlight) {
          setChosen((s) => {
            const n = new Set(s);
            if (n.has(highlight)) n.delete(highlight);
            else n.add(highlight);
            return n;
          });
        } else if (input === 'A') setChosen((s) => (s.size === names.length ? new Set() : new Set(names)));
      }
    },
    { isActive: active && step !== 'form' },
  );

  if (dialog.open) return <Box justifyContent="center">{dialog.element}</Box>;

  if (step === 'collections') {
    const list = sourceCollections.data ?? [];
    return (
      <Panel
        title={`Choose collections · ${form.sourceDb}`}
        right={`${chosen.size} of ${list.length} selected`}
        focus
      >
        {sourceCollections.loading ? <Loading /> : null}
        <SelectList
          items={list.map((c) => ({
            key: c.name,
            label: `${chosen.has(c.name) ? symbols.checkboxOn : symbols.checkboxOff} ${c.name}`,
            value: c.name,
            hint: c.type,
          }))}
          focus={active}
          height={layout.height - 4}
          width={layout.width - 4}
          showDescription={false}
          onHighlight={(item) => setHighlight(item?.value)}
          onSelect={() => setStep('form')}
        />
      </Panel>
    );
  }

  if (step === 'running') {
    const p = progress?.p;
    return (
      <Panel title="Copying…" right={progress ? progress.db : undefined} focus>
        <ProgressBar
          fraction={p ? progressFraction(p) : undefined}
          width={layout.width - 8}
          label={
            p
              ? `${formatNumber(p.processed)}${p.total ? ` of ~${formatNumber(p.total)}` : ''} documents · ${formatNumber(p.ratePerSecond)}/s${p.current ? ` · ${p.current}` : ''}`
              : 'Preparing…'
          }
        />
        {results.map((r) => (
          <Text key={r.target} color={col(theme, theme.colors.success)}>
            {symbols.check} {r.source} → {r.target}: {formatNumber(r.totalDocuments)} docs
          </Text>
        ))}
        <Muted>Esc cancels after the current batch; copied data stays in the target.</Muted>
      </Panel>
    );
  }

  if (step === 'done') {
    const rows = results.flatMap((r) => r.collections.map((c) => ({ ...c, db: r.target })));
    const aborted = results.find((r) => r.aborted);
    const failed = rows.filter((r) => r.status === 'failed').length;
    return (
      <Panel title="Copy summary" focus>
        <Text bold color={col(theme, aborted || failed ? theme.colors.warning : theme.colors.success)}>
          {aborted || failed ? symbols.warning : symbols.check}{' '}
          {aborted
            ? aborted.abortReason
            : `Copied ${formatNumber(results.reduce((a, r) => a + r.totalDocuments, 0))} document(s) in ${formatDuration(results.reduce((a, r) => a + r.durationMs, 0))}${failed ? ` · ${failed} failed` : ''}`}
        </Text>
        <DataTable
          columns={[
            { key: 'ns', title: 'Target', minWidth: 20, render: (r) => `${r.db} › ${r.collection}` },
            {
              key: 'src',
              title: 'Source docs',
              width: 11,
              align: 'right',
              render: (r) => (r.type === 'view' ? 'view' : formatNumber(r.sourceDocuments)),
            },
            {
              key: 'ins',
              title: 'Inserted',
              width: 9,
              align: 'right',
              render: (r) => formatNumber(r.inserted + r.replaced),
            },
            {
              key: 'skip',
              title: 'Skipped',
              width: 8,
              align: 'right',
              render: (r) => formatNumber(r.skippedDuplicates),
              priority: 1,
            },
            {
              key: 'idx',
              title: 'Idx',
              width: 4,
              align: 'right',
              render: (r) => String(r.indexes),
              priority: 0,
            },
            {
              key: 'st',
              title: 'Status',
              minWidth: 12,
              render: (r) => (r.message ? `${r.status}: ${r.message}` : r.status),
              color: (r) =>
                r.status === 'copied'
                  ? theme.colors.success
                  : r.status === 'skipped'
                    ? theme.colors.warning
                    : theme.colors.error,
            },
          ]}
          rows={rows}
          rowKey={(r) => `${r.db}.${r.collection}`}
          focus={active}
          height={layout.height - 5}
          width={layout.width - 4}
        />
      </Panel>
    );
  }

  const connectionOptions = (profiles.data ?? []).map((p) => ({
    label: `${p.name}${p.id === sourceProfile?.id ? ' (this connection)' : ''}${p.production ? ' · PROD' : ''}`,
    value: p.id,
  }));
  return (
    <Panel title="Copy / migrate data" right={sourceProfile ? `from ${sourceProfile.name}` : undefined} focus>
      <Form
        fields={[
          {
            key: 'scope',
            label: 'What to copy',
            kind: 'select',
            options: [
              { label: 'one database', value: 'database' },
              { label: 'ALL databases (to another connection)', value: 'all' },
            ],
          },
          {
            key: 'sourceDb',
            label: 'Source database',
            kind: 'combo',
            suggestions: ns.databases,
            suggestionsLoading: ns.loadingDatabases,
            newValueLabel: 'not found',
            hidden: form.scope === 'all',
          },
          {
            key: 'which',
            label: 'Collections',
            kind: 'select',
            hidden: form.scope === 'all',
            options: [
              { label: 'all collections and views', value: 'all' },
              { label: `choose… (${chosen.size} selected)`, value: 'choose' },
            ],
          },
          {
            key: 'targetId',
            label: 'Target connection',
            kind: 'select',
            options: connectionOptions,
            help: 'Another saved connection = migrate to another server',
          },
          {
            key: 'targetDb',
            label: 'Target database',
            kind: 'combo',
            suggestions: sameConnection ? ns.databases.filter((d) => d !== form.sourceDb) : [],
            newValueLabel: 'new database',
            placeholder: 'same name as the source',
            hidden: form.scope === 'all',
          },
          {
            key: 'duplicates',
            label: 'If _id already exists',
            kind: 'select',
            options: [
              { label: 'stop (never overwrite)', value: 'abort' },
              { label: 'skip those documents', value: 'skip' },
              { label: 'replace them', value: 'replace' },
            ],
          },
          {
            key: 'drop',
            label: 'Drop target first',
            kind: 'toggle',
            help: 'DESTRUCTIVE: replaces existing target collections completely',
          },
          { key: 'indexes', label: 'Copy indexes', kind: 'toggle' },
          { key: 'views', label: 'Copy views', kind: 'toggle' },
          { key: 'batchSize', label: 'Batch size', kind: 'number' },
        ]}
        values={form as unknown as Record<string, unknown>}
        onChange={set}
        focus={active}
        width={layout.width - 4}
        height={layout.height - 6}
        labelWidth={24}
        onCancel={() => nav.back()}
        actions={[
          {
            key: 'run',
            label: 'Copy',
            tone: form.drop || form.duplicates === 'replace' ? 'danger' : 'primary',
            onPress: () => void run(),
          },
          {
            key: 'choose',
            label: 'Choose collections…',
            disabled: form.scope === 'all' || !ns.databases.includes(form.sourceDb),
            onPress: () => {
              set('which', 'choose');
              setStep('collections');
            },
          },
          { key: 'cancel', label: 'Cancel', onPress: () => nav.back() },
        ]}
        footer={
          <Box flexDirection="column" marginTop={1}>
            {!sameConnection && target ? (
              <Text color={col(theme, theme.colors.info)} wrap="truncate-end">
                {symbols.info} Copies to another server: {truncate(target.name, 40)}. You confirm the target
                by name if it is production or the copy is destructive.
              </Text>
            ) : sameConnection && !state.writeEnabled ? (
              <Text color={col(theme, theme.colors.warning)}>
                {symbols.warning} Read-only session — press W to allow writes on this connection.
              </Text>
            ) : null}
            <Muted>
              Documents keep their exact BSON types; collection options (capped, validators), views and
              indexes are recreated.
            </Muted>
          </Box>
        }
      />
    </Panel>
  );
}
