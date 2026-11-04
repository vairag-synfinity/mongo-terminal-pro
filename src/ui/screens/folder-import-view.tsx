import { Box, Text, useInput } from 'ink';
import path from 'node:path';
import React, { useRef, useState } from 'react';
import { Operations } from '../../security/permission-manager.js';
import {
  FolderImportManager,
  planFolderImport,
  type FolderImportSummary,
  type FolderPlanEntry,
} from '../../transfer/folder-import.js';
import { progressFraction, type TransferProgress } from '../../transfer/transfer-progress.js';
import { formatBytes, formatDuration, formatNumber } from '../../utils/formatting.js';
import { DataTable } from '../components/data-table.js';
import { useDialog } from '../components/dialog.js';
import { ErrorBox, Muted, ProgressBar } from '../components/feedback.js';
import { FileBrowser } from '../components/file-browser.js';
import { Form } from '../components/form.js';
import { Panel } from '../components/panel.js';
import { cleanDroppedPath } from '../components/text-input.js';
import { useAppState, useScreenActive, useUi } from '../context.js';
import { useNamespaceSuggestions } from '../hooks/use-namespaces.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';
import { confirmOperation } from './confirm-operation.js';

interface FolderForm {
  folder: string;
  layout: 'database' | 'all';
  database: string;
  mode: 'insert' | 'upsert';
  duplicates: 'abort' | 'skip';
  batchSize: string;
  skipInvalid: boolean;
}

type Step = 'form' | 'browse' | 'plan' | 'running' | 'done';

/** Import a whole folder: one database, or every database from an "export all databases" folder. */
export function FolderImportView({ initialDb, onBack }: { initialDb?: string; onBack(): void }) {
  const { app, theme, symbols, settings, notify } = useUi();
  const state = useAppState();
  const screenActive = useScreenActive();
  const layout = useLayout();
  const dialog = useDialog(layout.width);
  const [form, setForm] = useState<FolderForm>({
    folder: settings.defaultExportDir || app.paths.exportsDir,
    layout: 'database',
    database: initialDb ?? '',
    mode: 'insert',
    duplicates: 'abort',
    batchSize: String(settings.importBatchSize),
    skipInvalid: false,
  });
  const [step, setStep] = useState<Step>('form');
  const [plan, setPlan] = useState<FolderPlanEntry[]>([]);
  const [error, setError] = useState<unknown>();
  const [progress, setProgress] = useState<{ label: string; p?: TransferProgress }>({ label: '' });
  const [result, setResult] = useState<FolderImportSummary | undefined>();
  const abort = useRef<AbortController | undefined>(undefined);
  const ns = useNamespaceSuggestions(form.database);
  const active = screenActive && !dialog.open;

  const makePlan = async () => {
    setError(undefined);
    try {
      setPlan(
        await planFolderImport({
          dir: cleanDroppedPath(form.folder),
          database: form.database,
          allDatabases: form.layout === 'all',
        }),
      );
      setStep('plan');
    } catch (e) {
      setError(e);
    }
  };

  const start = async (dryRun: boolean) => {
    if (!dryRun) {
      const dbs = [...new Set(plan.map((p) => p.database))];
      const op = form.mode === 'upsert' ? Operations.importUpsert : Operations.importInsert;
      const ok = await confirmOperation(
        { app, dialog, notify },
        op,
        `Import ${plan.length} file(s) into ${dbs.join(', ')}?`,
        ['Every file is validated first; nothing is written if a file has invalid records.'],
        true,
      );
      if (!ok) return;
    }
    const ac = new AbortController();
    abort.current = ac;
    setStep('running');
    try {
      const res = await new FolderImportManager(app.connectionManager.getClient(), app.permissions).run({
        plan,
        mode: form.mode,
        duplicates: form.duplicates,
        batchSize: Math.max(1, Number(form.batchSize) || settings.importBatchSize),
        skipInvalid: form.skipInvalid,
        dryRun,
        signal: ac.signal,
        onFile: (e, i, phase) =>
          setProgress({
            label: `${phase === 'validate' ? 'Validating' : 'Importing'} ${i + 1}/${plan.length}: ${e.database}.${e.collection}`,
          }),
        onProgress: (p) => setProgress((s) => ({ ...s, p })),
      });
      setResult(res);
      setStep('done');
      if (!dryRun) app.events.emit('metadata:invalidated', {});
    } catch (e) {
      setError(e);
      setStep('plan');
    }
  };

  useHints(
    step === 'running'
      ? [{ key: 'Esc', label: 'cancel' }]
      : step === 'plan'
        ? [{ key: 'Esc', label: 'back' }]
        : step === 'done'
          ? [{ key: 'Enter', label: 'done' }]
          : [
              { key: 'Tab', label: 'next field' },
              { key: 'Esc', label: 'back' },
            ],
    [step],
  );
  useInput(
    (_input, key) => {
      if (step === 'running' && key.escape) abort.current?.abort();
      else if (step === 'done' && (key.return || key.escape)) setStep('form');
    },
    { isActive: active && (step === 'running' || step === 'done') },
  );

  if (dialog.open) return <Box justifyContent="center">{dialog.element}</Box>;

  if (step === 'browse') {
    return (
      <Panel title="Choose the folder to import" focus>
        <FileBrowser
          initialDir={path.resolve(cleanDroppedPath(form.folder) || process.cwd())}
          mode="directory"
          focus={active}
          height={layout.height - 3}
          width={layout.width - 4}
          onPick={(dir) => {
            setForm((f) => ({ ...f, folder: dir, database: f.database || path.basename(dir) }));
            setStep('form');
          }}
          onCancel={() => setStep('form')}
        />
      </Panel>
    );
  }

  if (step === 'running') {
    const p = progress.p;
    return (
      <Panel title="Folder import" focus>
        <Text>{progress.label}</Text>
        <ProgressBar
          fraction={p ? progressFraction(p) : undefined}
          width={layout.width - 8}
          label={p ? `${formatNumber(p.processed)} records · ${formatBytes(p.bytes)}` : undefined}
        />
        <Muted>Esc cancels after the current batch.</Muted>
      </Panel>
    );
  }

  if (step === 'done' && result) {
    return (
      <Panel title={result.dryRun ? 'Folder dry run' : 'Folder import summary'} focus>
        <Text
          bold
          color={col(theme, result.aborted || result.invalid ? theme.colors.warning : theme.colors.success)}
        >
          {result.aborted || result.invalid ? symbols.warning : symbols.check}{' '}
          {result.dryRun
            ? result.invalid === 0
              ? 'All files are valid — nothing was written.'
              : `${result.invalid} invalid record(s) — nothing was written.`
            : result.aborted
              ? result.abortReason
              : `Imported ${formatNumber(result.documents)} document(s) in ${formatDuration(result.durationMs)}`}
        </Text>
        <DataTable
          columns={[
            {
              key: 't',
              title: 'Target',
              minWidth: 18,
              render: (r) => `${r.entry.database}.${r.entry.collection}`,
            },
            {
              key: 'read',
              title: 'Read',
              width: 9,
              align: 'right',
              render: (r) => formatNumber(r.summary.read),
            },
            {
              key: 'inv',
              title: 'Invalid',
              width: 8,
              align: 'right',
              render: (r) => formatNumber(r.summary.invalid),
              color: (r) => (r.summary.invalid ? theme.colors.error : undefined),
            },
            {
              key: 'ins',
              title: 'Written',
              width: 9,
              align: 'right',
              render: (r) => formatNumber(r.summary.inserted + r.summary.upserted),
            },
            {
              key: 'dup',
              title: 'Skipped',
              width: 8,
              align: 'right',
              render: (r) => formatNumber(r.summary.skippedDuplicates),
              priority: 1,
            },
          ]}
          rows={result.results}
          rowKey={(r) => r.entry.file}
          focus={active}
          height={layout.height - 5}
          width={layout.width - 4}
        />
      </Panel>
    );
  }

  if (step === 'plan') {
    const dbs = [...new Set(plan.map((p) => p.database))];
    return (
      <Panel title={`Import plan · ${plan.length} file(s) → ${dbs.length} database(s)`} focus>
        {error ? <ErrorBox error={error} /> : null}
        <DataTable
          columns={[
            { key: 'f', title: 'File', minWidth: 16, render: (p) => path.basename(p.file) },
            { key: 't', title: 'Target', minWidth: 18, render: (p) => `${p.database}.${p.collection}` },
            { key: 's', title: 'Size', width: 10, align: 'right', render: (p) => formatBytes(p.size) },
          ]}
          rows={plan}
          rowKey={(p) => p.file}
          focus={false}
          height={Math.max(3, layout.height - 9)}
          width={layout.width - 4}
        />
        <Form
          fields={[]}
          values={{}}
          onChange={() => undefined}
          focus={active}
          width={layout.width - 4}
          onCancel={() => setStep('form')}
          actions={[
            { key: 'dry', label: 'Dry run (validate only)', onPress: () => void start(true) },
            {
              key: 'go',
              label: 'Import all',
              tone: form.mode === 'upsert' ? 'danger' : 'primary',
              onPress: () => void start(false),
            },
            { key: 'back', label: 'Back', onPress: () => setStep('form') },
          ]}
          footer={
            !state.writeEnabled ? (
              <Text color={col(theme, theme.colors.warning)}>
                {symbols.warning} Read-only session — press W to enable writes (dry run works without).
              </Text>
            ) : undefined
          }
        />
      </Panel>
    );
  }

  return (
    <Panel title="Import a folder" focus>
      <Muted>
        One file per collection: users.json → users. "Every database" expects
        &lt;folder&gt;/&lt;database&gt;/&lt;collection&gt;.json (made by Export → all databases).
      </Muted>
      {error ? <ErrorBox error={error} /> : null}
      <Form
        fields={[
          { key: 'folder', label: 'Folder', kind: 'text' },
          {
            key: 'layout',
            label: 'Folder contains',
            kind: 'select',
            options: [
              { label: 'collections of ONE database', value: 'database' },
              { label: 'one sub-folder per database (all)', value: 'all' },
            ],
          },
          {
            key: 'database',
            label: 'Target database',
            kind: 'combo',
            suggestions: ns.databases,
            suggestionsLoading: ns.loadingDatabases,
            newValueLabel: 'new database',
            hidden: form.layout === 'all',
          },
          {
            key: 'mode',
            label: 'Mode',
            kind: 'select',
            options: [
              { label: 'insert (never overwrite)', value: 'insert' },
              { label: 'upsert by _id (replace matches)', value: 'upsert' },
            ],
          },
          {
            key: 'duplicates',
            label: 'On duplicate _id',
            kind: 'select',
            hidden: form.mode !== 'insert',
            options: [
              { label: 'stop', value: 'abort' },
              { label: 'skip and continue', value: 'skip' },
            ],
          },
          { key: 'batchSize', label: 'Batch size', kind: 'number' },
          { key: 'skipInvalid', label: 'Skip invalid records', kind: 'toggle' },
        ]}
        values={form as unknown as Record<string, unknown>}
        onChange={(k, v) =>
          setForm((f) => ({ ...f, [k]: k === 'folder' ? cleanDroppedPath(String(v)) : v }) as FolderForm)
        }
        focus={active}
        width={layout.width - 4}
        onCancel={onBack}
        actions={[
          { key: 'browse', label: 'Browse folder…', onPress: () => setStep('browse') },
          { key: 'plan', label: 'Next: review files', tone: 'primary', onPress: () => void makePlan() },
          { key: 'back', label: 'Single file import', onPress: onBack },
        ]}
      />
    </Panel>
  );
}
