import { Box, Text, useInput } from 'ink';
import path from 'node:path';
import React, { useRef, useState } from 'react';
import { Operations } from '../../security/permission-manager.js';
import type { CsvFieldMapping, CsvFieldType } from '../../transfer/csv-handler.js';
import { defaultMapping } from '../../transfer/csv-handler.js';
import {
  ImportManager,
  previewImportFile,
  type ImportPreview,
  type ImportSummary,
} from '../../transfer/import-manager.js';
import type { TransferFormat } from '../../transfer/import-validator.js';
import { progressFraction, type TransferProgress } from '../../transfer/transfer-progress.js';
import {
  formatBytes,
  formatDuration,
  formatNumber,
  timestampForFilename,
  truncate,
} from '../../utils/formatting.js';
import { useDialog } from '../components/dialog.js';
import { ErrorBox, Loading, Muted, ProgressBar } from '../components/feedback.js';
import { FileBrowser } from '../components/file-browser.js';
import { Form } from '../components/form.js';
import { JsonView } from '../components/json-view.js';
import { Panel } from '../components/panel.js';
import { SelectList } from '../components/select-list.js';
import { cleanDroppedPath } from '../components/text-input.js';
import { useAppState, useScreenActive, useUi } from '../context.js';
import { useDraft } from '../hooks/use-draft.js';
import { useNamespaceSuggestions } from '../hooks/use-namespaces.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';
import { confirmOperation } from './confirm-operation.js';

type Step = 'source' | 'browse' | 'preview' | 'options' | 'running' | 'summary';
const CSV_TYPES: CsvFieldType[] = [
  'auto',
  'string',
  'number',
  'int',
  'boolean',
  'date',
  'objectId',
  'json',
  'skip',
];

interface SourceForm {
  file: string;
  format: 'auto' | TransferFormat;
  database: string;
  collection: string;
  delimiter: string;
  emptyValues: 'omit' | 'null' | 'empty-string';
}

interface OptionsForm {
  mode: 'insert' | 'upsert';
  upsertKeys: string;
  duplicates: 'abort' | 'skip';
  batchSize: string;
  ordered: boolean;
  validateFirst: boolean;
  skipInvalid: boolean;
  writeErrorReport: boolean;
}

export function ImportScreen({ params }: { params: { db?: string; collection?: string } }) {
  const { app, nav, theme, settings, symbols, notify, notifyError } = useUi();
  const state = useAppState();
  const screenActive = useScreenActive();
  const layout = useLayout();
  const dialog = useDialog(layout.width);
  const [step, setStep] = useState<Step>('source');
  const [source, setSource] = useDraft<SourceForm>('import:source', () => ({
    file: '',
    format: 'auto',
    database: params.db ?? state.database ?? '',
    collection: params.collection ?? state.collection ?? '',
    delimiter: ',',
    emptyValues: 'omit',
  }));
  const [options, setOptions] = useDraft<OptionsForm>('import:options', () => ({
    mode: 'insert',
    upsertKeys: '_id',
    duplicates: 'abort',
    batchSize: String(settings.importBatchSize),
    ordered: true,
    validateFirst: true,
    skipInvalid: false,
    writeErrorReport: true,
  }));
  const ns = useNamespaceSuggestions(source.database);
  const [preview, setPreview] = useState<ImportPreview | undefined>();
  const [mapping, setMapping] = useState<CsvFieldMapping[] | undefined>();
  const [mappingIndex, setMappingIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [progress, setProgress] = useState<TransferProgress | undefined>();
  const [summary, setSummary] = useState<ImportSummary | undefined>();
  const abort = useRef<AbortController | undefined>(undefined);
  const active = screenActive && !dialog.open && !loading;

  const csvOptions = () => ({ delimiter: source.delimiter || ',', emptyValues: source.emptyValues, mapping });

  const loadPreview = async (withMapping = mapping) => {
    if (!source.file.trim()) return notify('warning', 'Choose a file first');
    if (!source.database.trim() || !source.collection.trim())
      return notify('warning', 'Target database and collection are required');
    setLoading(true);
    setError(undefined);
    try {
      const p = await previewImportFile(
        cleanDroppedPath(source.file),
        source.format === 'auto' ? undefined : source.format,
        5,
        { delimiter: source.delimiter || ',', emptyValues: source.emptyValues, mapping: withMapping },
      );
      setPreview(p);
      if (p.csv && !withMapping) setMapping(defaultMapping(p.csv.headers));
      setStep('preview');
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  const start = async (dryRun: boolean) => {
    if (!preview) return;
    const upsert = options.mode === 'upsert';
    if (!dryRun) {
      const op = upsert ? Operations.importUpsert : Operations.importInsert;
      const ok = await confirmOperation(
        { app, dialog, notify },
        op,
        `Import ${path.basename(preview.file)} (${formatBytes(preview.size)}) into ${source.database}.${source.collection}?`,
        upsert
          ? [`Documents matching on [${options.upsertKeys}] will be REPLACED.`]
          : ['Existing documents are never modified in insert mode.'],
        true,
      );
      if (!ok) return;
    }
    const ac = new AbortController();
    abort.current = ac;
    setStep('running');
    setProgress(undefined);
    try {
      const reportPath = options.writeErrorReport
        ? path.join(
            settings.defaultExportDir || app.paths.exportsDir,
            `import-errors-${timestampForFilename()}.jsonl`,
          )
        : undefined;
      if (reportPath)
        await import('node:fs').then((fs) =>
          fs.promises.mkdir(path.dirname(reportPath), { recursive: true }),
        );
      const manager = new ImportManager(app.connectionManager.getClient(), app.permissions);
      const result = await manager.run({
        file: preview.file,
        format: preview.format,
        database: source.database.trim(),
        collection: source.collection.trim(),
        mode: options.mode,
        upsertKeys: options.upsertKeys
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        duplicates: options.duplicates,
        batchSize: Math.max(1, Number(options.batchSize) || settings.importBatchSize),
        ordered: options.ordered,
        validateFirst: options.validateFirst,
        skipInvalid: options.skipInvalid,
        dryRun,
        csv: csvOptions(),
        errorReportPath: reportPath,
        signal: ac.signal,
        onProgress: setProgress,
      });
      setSummary(result);
      setStep('summary');
      if (!dryRun)
        app.events.emit('metadata:invalidated', { database: source.database, collection: source.collection });
    } catch (e) {
      notifyError(e, 'Import failed');
      setStep('options');
    }
  };

  useHints(
    step === 'preview'
      ? [
          { key: 'o/Enter', label: 'options' },
          ...(mapping
            ? [
                { key: '↑↓', label: 'column' },
                { key: '←→', label: 'type' },
                { key: 't', label: 'target name' },
              ]
            : []),
          { key: 'Esc', label: 'back' },
        ]
      : step === 'running'
        ? [{ key: 'Esc', label: 'cancel import' }]
        : step === 'summary'
          ? [
              { key: 'Enter', label: 'done' },
              { key: 'v', label: 'view documents' },
            ]
          : [
              { key: 'Tab', label: 'next field' },
              { key: 'Esc', label: 'back' },
            ],
    [step, Boolean(mapping)],
  );

  useInput(
    (input, key) => {
      if (step === 'running') {
        if (key.escape) abort.current?.abort();
        return;
      }
      if (step === 'summary') {
        if (key.return || key.escape) nav.back();
        else if (input === 'v')
          nav.replace('documents', { db: source.database, collection: source.collection });
        return;
      }
      if (step !== 'preview') return;
      if (key.escape) return setStep('source');
      if (input === 'o' || key.return) return setStep('options');
      if (!mapping) return;
      if (key.upArrow) setMappingIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setMappingIndex((i) => Math.min(mapping.length - 1, i + 1));
      else if (key.leftArrow || key.rightArrow) {
        const next = mapping.map((m, i) => {
          if (i !== mappingIndex) return m;
          const pos = CSV_TYPES.indexOf(m.type);
          return {
            ...m,
            type: CSV_TYPES[
              (pos + (key.leftArrow ? -1 : 1) + CSV_TYPES.length) % CSV_TYPES.length
            ] as CsvFieldType,
          };
        });
        setMapping(next);
        void loadPreview(next);
      } else if (input === 't') {
        const m = mapping[mappingIndex];
        if (!m) return;
        void dialog
          .prompt({
            title: `Target field for column "${m.source}"`,
            label: 'Field:',
            initial: m.target,
            help: 'Use dots for nested fields, e.g. address.city',
          })
          .then((v) => {
            if (!v) return;
            const next = mapping.map((x, i) => (i === mappingIndex ? { ...x, target: v.trim() } : x));
            setMapping(next);
            void loadPreview(next);
          });
      }
    },
    { isActive: active && (step === 'preview' || step === 'running' || step === 'summary') },
  );

  if (dialog.open) return <Box justifyContent="center">{dialog.element}</Box>;
  if (loading) return <Loading label="Reading file preview…" />;

  if (step === 'browse') {
    return (
      <Panel title="Choose a file to import" focus>
        <FileBrowser
          initialDir={source.file ? path.dirname(path.resolve(cleanDroppedPath(source.file))) : process.cwd()}
          extensions={['.json', '.jsonl', '.ndjson', '.csv', '.tsv', '.bson', '.gz']}
          mode="file"
          focus={active}
          height={layout.height - 3}
          width={layout.width - 4}
          onPick={(file) => {
            setSource((s) => ({
              ...s,
              file,
              collection:
                s.collection ||
                path.basename(file).replace(/\.(json|jsonl|ndjson|csv|tsv|bson)(\.gz)?$/i, ''),
            }));
            setStep('source');
          }}
          onCancel={() => setStep('source')}
        />
      </Panel>
    );
  }

  if (step === 'source') {
    return (
      <Panel title="Import · source and target" focus>
        <Muted>
          Type or paste a path, drag a file onto the terminal (pastes its path), or choose Browse.
        </Muted>
        {error ? <ErrorBox error={error} /> : null}
        <Form
          fields={[
            { key: 'file', label: 'File', kind: 'text', placeholder: path.join(process.cwd(), 'data.json') },
            {
              key: 'format',
              label: 'Format',
              kind: 'select',
              options: [
                { label: 'auto (from extension)', value: 'auto' },
                { label: 'JSON / JSONL / Extended JSON', value: 'json' },
                { label: 'CSV', value: 'csv' },
                { label: 'BSON (mongodump)', value: 'bson' },
              ],
            },
            {
              key: 'database',
              label: 'Target database',
              kind: 'combo',
              suggestions: ns.databases,
              suggestionsLoading: ns.loadingDatabases,
              newValueLabel: 'new database',
            },
            {
              key: 'collection',
              label: 'Target collection',
              kind: 'combo',
              suggestions: ns.writableCollections,
              suggestionsLoading: ns.loadingCollections,
              newValueLabel: 'new collection',
              help: 'Created automatically if it does not exist',
            },
            {
              key: 'delimiter',
              label: 'CSV delimiter',
              kind: 'text',
              hidden: !(source.format === 'csv' || /\.(csv|tsv)(\.gz)?$/i.test(source.file)),
            },
            {
              key: 'emptyValues',
              label: 'CSV empty cells',
              kind: 'select',
              hidden: !(source.format === 'csv' || /\.(csv|tsv)(\.gz)?$/i.test(source.file)),
              options: [
                { label: 'omit field', value: 'omit' },
                { label: 'null', value: 'null' },
                { label: 'empty string', value: 'empty-string' },
              ],
            },
          ]}
          values={source as unknown as Record<string, unknown>}
          onChange={(k, v) =>
            setSource((s) => ({ ...s, [k]: k === 'file' ? cleanDroppedPath(String(v)) : v }))
          }
          focus={active}
          width={layout.width - 4}
          onCancel={() => nav.back()}
          actions={[
            { key: 'browse', label: 'Browse…', onPress: () => setStep('browse') },
            { key: 'preview', label: 'Preview', tone: 'primary', onPress: () => void loadPreview(undefined) },
            { key: 'cancel', label: 'Cancel', onPress: () => nav.back() },
          ]}
        />
      </Panel>
    );
  }

  if (step === 'preview' && preview) {
    const info = `${preview.format.toUpperCase()}${preview.gzip ? ' (gzip)' : ''} · ${formatBytes(preview.size)}`;
    return (
      <Box flexDirection="column">
        <Panel title={`Preview · ${path.basename(preview.file)}`} right={info} focus>
          {preview.errors.map((e, i) => (
            <Text key={i} color={col(theme, theme.colors.error)} wrap="truncate-end">
              {symbols.cross} {e}
            </Text>
          ))}
          {mapping ? (
            <Box flexDirection="column">
              <Text bold>Field mapping (← → change type, t rename target)</Text>
              <SelectList
                items={mapping.map((m, i) => ({
                  key: m.source,
                  label: `${m.source}  ${symbols.arrowRight}  ${m.type === 'skip' ? '(skipped)' : m.target}`,
                  value: i,
                  hint: m.type,
                  color: m.type === 'skip' ? theme.colors.muted : undefined,
                }))}
                focus={false}
                initialIndex={mappingIndex}
                height={Math.min(mapping.length + 1, Math.floor(layout.height / 2) - 2)}
                width={layout.width - 6}
                showDescription={false}
                onSelect={() => undefined}
              />
              <Text color={col(theme, theme.colors.accent)}>Selected: {mapping[mappingIndex]?.source}</Text>
            </Box>
          ) : null}
          <JsonView
            value={preview.documents}
            focus={false}
            height={Math.max(
              4,
              mapping ? Math.floor(layout.height / 2) - 4 : layout.height - 6 - preview.errors.length,
            )}
            width={layout.width - 4}
            initialDepth={2}
          />
        </Panel>
        <Muted>
          Showing the first {preview.documents.length} record(s). The full file is validated before anything
          is written.
        </Muted>
      </Box>
    );
  }

  if (step === 'options') {
    return (
      <Panel title={`Import options · ${source.database}.${source.collection}`} focus>
        <Form
          fields={[
            {
              key: 'mode',
              label: 'Mode',
              kind: 'select',
              options: [
                { label: 'insert (never overwrite)', value: 'insert' },
                { label: 'upsert (replace matches)', value: 'upsert' },
              ],
            },
            {
              key: 'upsertKeys',
              label: 'Upsert match fields',
              kind: 'text',
              hidden: options.mode !== 'upsert',
              help: 'Comma-separated, default _id',
            },
            {
              key: 'duplicates',
              label: 'On duplicate key',
              kind: 'select',
              hidden: options.mode !== 'insert',
              options: [
                { label: 'abort import', value: 'abort' },
                { label: 'skip and continue', value: 'skip' },
              ],
            },
            { key: 'batchSize', label: 'Batch size', kind: 'number' },
            {
              key: 'ordered',
              label: 'Ordered writes',
              kind: 'toggle',
              help: 'Unordered is faster and continues after errors',
            },
            {
              key: 'validateFirst',
              label: 'Validate whole file first',
              kind: 'toggle',
              help: 'Recommended: nothing is written if any record is invalid',
            },
            { key: 'skipInvalid', label: 'Skip invalid records', kind: 'toggle' },
            {
              key: 'writeErrorReport',
              label: 'Write error report',
              kind: 'toggle',
              help: 'JSONL report in the exports directory',
            },
          ]}
          values={options as unknown as Record<string, unknown>}
          onChange={(k, v) => setOptions((o) => ({ ...o, [k]: v }))}
          focus={active}
          width={layout.width - 4}
          onCancel={() => setStep('preview')}
          actions={[
            { key: 'dry', label: 'Dry run (validate only)', onPress: () => void start(true) },
            {
              key: 'run',
              label: 'Import',
              tone: options.mode === 'upsert' ? 'danger' : 'primary',
              onPress: () => void start(false),
            },
            { key: 'back', label: 'Back', onPress: () => setStep('preview') },
          ]}
          footer={
            !state.writeEnabled ? (
              <Text color={col(theme, theme.colors.warning)}>
                {symbols.warning} Session is read-only — press W to enable writes before importing (dry run
                works without).
              </Text>
            ) : undefined
          }
        />
      </Panel>
    );
  }

  if (step === 'running') {
    const p = progress;
    return (
      <Panel title={`Importing into ${source.database}.${source.collection}`} focus>
        <Text>
          Phase: <Text bold>{p?.phase ?? 'starting'}</Text>
        </Text>
        <ProgressBar
          fraction={p ? progressFraction(p) : undefined}
          width={layout.width - 8}
          label={
            p
              ? `${formatNumber(p.processed)} records · ${formatBytes(p.bytes)}${p.totalBytes ? ` of ${formatBytes(p.totalBytes)}` : ''} · ${formatNumber(p.ratePerSecond)}/s${p.etaSeconds !== undefined ? ` · ETA ${formatDuration(p.etaSeconds * 1000)}` : ''}`
              : 'Opening file…'
          }
        />
        <Muted>Esc cancels after the current batch; already-written batches remain.</Muted>
      </Panel>
    );
  }

  if (step === 'summary' && summary) {
    const s = summary;
    const ok = !s.aborted && s.failed === 0 && s.invalid === 0;
    const rows: [string, string][] = [
      ['Records read', formatNumber(s.read)],
      ['Valid / invalid', `${formatNumber(s.valid)} / ${formatNumber(s.invalid)}`],
      ...(!s.dryRun
        ? ([
            ['Inserted', formatNumber(s.inserted)],
            ...(s.mode === 'upsert'
              ? [
                  [
                    'Upserted / matched / modified',
                    `${formatNumber(s.upserted)} / ${formatNumber(s.matched)} / ${formatNumber(s.modified)}`,
                  ] as [string, string],
                ]
              : []),
            ['Skipped duplicates', formatNumber(s.skippedDuplicates)],
            ['Failed writes', formatNumber(s.failed)],
          ] as [string, string][])
        : []),
      ['Duration', formatDuration(s.durationMs)],
    ];
    return (
      <Panel title={s.dryRun ? 'Dry run result' : 'Import summary'} focus>
        <Text
          bold
          color={col(
            theme,
            ok ? theme.colors.success : s.aborted ? theme.colors.error : theme.colors.warning,
          )}
        >
          {ok ? symbols.check : symbols.warning}{' '}
          {s.dryRun
            ? s.invalid === 0
              ? 'File is valid — nothing was written.'
              : `${s.invalid} invalid record(s) — nothing was written.`
            : s.aborted
              ? (s.abortReason ?? 'Import aborted')
              : `Imported into ${s.database}.${s.collection}`}
        </Text>
        {rows.map(([k, v]) => (
          <Text key={k}>
            {k.padEnd(32)} {v}
          </Text>
        ))}
        {s.errors.slice(0, Math.max(0, layout.height - rows.length - 8)).map((e, i) => (
          <Text key={i} color={col(theme, theme.colors.error)} wrap="truncate-end">
            #{e.index + 1}
            {e.location ? ` (${e.location})` : ''}: {truncate(e.message, layout.width - 20)}
          </Text>
        ))}
        {s.errorReportPath ? <Muted>Full error report: {s.errorReportPath}</Muted> : null}
      </Panel>
    );
  }
  return null;
}
