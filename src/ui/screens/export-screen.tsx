import { Box, Text, useInput } from 'ink';
import path from 'node:path';
import React, { useRef, useState } from 'react';
import {
  ExportManager,
  extensionFor,
  JSON_MODE_EXPLANATION,
  type ExportSummary,
} from '../../transfer/export-manager.js';
import type { TransferFormat } from '../../transfer/import-validator.js';
import type { JsonLayout, JsonMode } from '../../transfer/json-handler.js';
import { progressFraction, type TransferProgress } from '../../transfer/transfer-progress.js';
import {
  formatBytes,
  formatDuration,
  formatNumber,
  timestampForFilename,
  truncate,
} from '../../utils/formatting.js';
import { parseMongoObject } from '../../utils/validation.js';
import { useDialog } from '../components/dialog.js';
import { Muted, ProgressBar } from '../components/feedback.js';
import { FileBrowser } from '../components/file-browser.js';
import { Form } from '../components/form.js';
import { Panel } from '../components/panel.js';
import { useAppState, useScreenActive, useUi } from '../context.js';
import { useDraft } from '../hooks/use-draft.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';

interface Params {
  db?: string;
  collection?: string;
  filter?: string;
  sort?: string;
  projection?: string;
}

interface ExportForm {
  database: string;
  scope: 'collection' | 'database';
  collection: string;
  format: TransferFormat;
  jsonMode: JsonMode;
  layout: JsonLayout;
  filter: string;
  sort: string;
  fields: string;
  limit: string;
  output: string;
  overwrite: boolean;
  batchSize: string;
}

type Step = 'form' | 'browse' | 'running' | 'done';

export function ExportScreen({ params }: { params: Params }) {
  const { app, nav, theme, settings, symbols, notifyError } = useUi();
  const state = useAppState();
  const screenActive = useScreenActive();
  const layout = useLayout();
  const dialog = useDialog(layout.width);
  const [form, setForm] = useDraft<ExportForm>(
    `export:${params.db ?? ''}.${params.collection ?? ''}`,
    () => ({
      database: params.db ?? state.database ?? '',
      scope: 'collection',
      collection: params.collection ?? state.collection ?? '',
      format: settings.lastExportFormat ?? 'json',
      jsonMode: 'relaxed',
      layout: 'array',
      filter: params.filter ?? '{}',
      sort: params.sort ?? '',
      fields: '',
      limit: '',
      output: '',
      overwrite: false,
      batchSize: String(settings.exportBatchSize),
    }),
  );
  const [step, setStep] = useState<Step>('form');
  const [progress, setProgress] = useState<TransferProgress | undefined>();
  const [summary, setSummary] = useState<ExportSummary | undefined>();
  const abort = useRef<AbortController | undefined>(undefined);
  const active = screenActive && !dialog.open;

  const baseDir = settings.defaultExportDir || app.paths.exportsDir;
  const defaultOutput = () =>
    form.scope === 'collection'
      ? path.join(
          baseDir,
          `${form.database}.${form.collection}_${timestampForFilename()}${extensionFor(form.format, form.layout)}`,
        )
      : path.join(baseDir, `${form.database}_${timestampForFilename()}`);

  const run = async () => {
    if (!form.database.trim()) return notifyError(new Error('Database is required'), 'Missing database');
    if (form.scope === 'collection' && !form.collection.trim())
      return notifyError(new Error('Collection is required'), 'Missing collection');
    let filter, sort;
    try {
      filter = parseMongoObject(form.filter, 'Filter');
      sort = form.sort.trim() ? parseMongoObject(form.sort, 'Sort') : undefined;
    } catch (e) {
      return notifyError(e, 'Invalid query');
    }
    const output = form.output.trim() || defaultOutput();
    const ac = new AbortController();
    abort.current = ac;
    setStep('running');
    setProgress(undefined);
    try {
      const manager = new ExportManager(app.connectionManager.getClient());
      const result = await manager.run({
        database: form.database.trim(),
        collection: form.scope === 'collection' ? form.collection.trim() : undefined,
        format: form.format,
        output,
        overwrite: form.overwrite,
        filter,
        sort: sort as never,
        fields: form.fields
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean),
        limit: form.limit ? Number(form.limit) : undefined,
        batchSize: Math.max(1, Number(form.batchSize) || settings.exportBatchSize),
        jsonMode: form.jsonMode,
        jsonLayout: form.layout,
        maxTimeMS: settings.queryTimeoutMs * 10,
        signal: ac.signal,
        onProgress: setProgress,
      });
      setSummary(result);
      setStep('done');
      void app.config.set('lastExportFormat', form.format);
    } catch (e) {
      notifyError(e, 'Export failed');
      setStep('form');
    }
  };

  useHints(
    step === 'running'
      ? [{ key: 'Esc', label: 'cancel' }]
      : step === 'done'
        ? [{ key: 'Enter', label: 'done' }]
        : [
            { key: 'Tab', label: 'next field' },
            { key: 'Ctrl+S', label: 'export' },
            { key: 'Esc', label: 'back' },
          ],
    [step],
  );
  useInput(
    (_input, key) => {
      if (step === 'running' && key.escape) abort.current?.abort();
      if (step === 'done' && (key.return || key.escape)) nav.back();
    },
    { isActive: active && (step === 'running' || step === 'done') },
  );

  if (dialog.open) return <Box justifyContent="center">{dialog.element}</Box>;

  if (step === 'browse') {
    return (
      <Panel title="Choose output directory" focus>
        <FileBrowser
          initialDir={baseDir}
          mode="directory"
          focus={active}
          height={layout.height - 3}
          width={layout.width - 4}
          onPick={(dir) => {
            setForm((f) => ({
              ...f,
              output:
                f.scope === 'collection'
                  ? path.join(dir, `${f.database}.${f.collection}${extensionFor(f.format, f.layout)}`)
                  : dir,
            }));
            setStep('form');
          }}
          onCancel={() => setStep('form')}
        />
      </Panel>
    );
  }

  if (step === 'running') {
    const p = progress;
    return (
      <Panel
        title={`Exporting ${form.database}${form.scope === 'collection' ? `.${form.collection}` : ' (all collections)'}`}
        focus
      >
        <ProgressBar
          fraction={p ? progressFraction(p) : undefined}
          width={layout.width - 8}
          label={
            p
              ? `${formatNumber(p.processed)}${p.total !== undefined ? ` of ${p.totalIsEstimate ? '~' : ''}${formatNumber(p.total)}` : ''} documents · ${formatBytes(p.bytes)} · ${formatNumber(p.ratePerSecond)}/s${p.current ? ` · ${p.current}` : ''}`
              : 'Starting…'
          }
        />
        <Muted>Esc cancels; partial files are removed.</Muted>
      </Panel>
    );
  }

  if (step === 'done' && summary) {
    return (
      <Panel title="Export complete" focus>
        <Text color={col(theme, theme.colors.success)} bold>
          {symbols.check} Exported {formatNumber(summary.totalDocuments)} document(s),{' '}
          {formatBytes(summary.totalBytes)} in {formatDuration(summary.durationMs)}
        </Text>
        {summary.files.slice(0, layout.height - 8).map((f) => (
          <Text key={f.path} wrap="truncate-end">
            {symbols.dot} {f.collection}: {formatNumber(f.documents)} docs, {formatBytes(f.bytes)}{' '}
            {symbols.arrowRight} {f.path}
          </Text>
        ))}
        {summary.skipped.map((s) => (
          <Text key={s.collection} color={col(theme, theme.colors.warning)}>
            {symbols.warning} skipped {s.collection}: {s.reason}
          </Text>
        ))}
        {summary.jsonMode ? (
          <Muted>
            JSON mode: {summary.jsonMode}
            {summary.jsonMode === 'plain' ? ' (BSON types were converted; not lossless)' : ' Extended JSON'}
          </Muted>
        ) : null}
      </Panel>
    );
  }

  const isJson = form.format === 'json';
  return (
    <Panel title="Export" right={`default folder: ${truncate(baseDir, 40)}`} focus>
      <Form
        fields={[
          { key: 'database', label: 'Database', kind: 'text' },
          {
            key: 'scope',
            label: 'Scope',
            kind: 'select',
            options: [
              { label: 'single collection', value: 'collection' },
              { label: 'entire database (one file per collection)', value: 'database' },
            ],
          },
          { key: 'collection', label: 'Collection', kind: 'text', hidden: form.scope !== 'collection' },
          {
            key: 'format',
            label: 'Format',
            kind: 'select',
            options: [
              { label: 'JSON', value: 'json' },
              { label: 'CSV', value: 'csv' },
              { label: 'BSON (mongorestore compatible)', value: 'bson' },
            ],
          },
          {
            key: 'jsonMode',
            label: 'JSON flavour',
            kind: 'select',
            hidden: !isJson,
            options: [
              { label: 'Relaxed Extended JSON', value: 'relaxed' },
              { label: 'Canonical Extended JSON (lossless)', value: 'canonical' },
              { label: 'Plain JSON (lossy)', value: 'plain' },
            ],
          },
          {
            key: 'layout',
            label: 'JSON layout',
            kind: 'select',
            hidden: !isJson,
            options: [
              { label: 'array [ … ]', value: 'array' },
              { label: 'JSON Lines (one per line)', value: 'jsonl' },
            ],
          },
          { key: 'filter', label: 'Filter', kind: 'text', hidden: form.scope !== 'collection' },
          { key: 'sort', label: 'Sort', kind: 'text', hidden: form.scope !== 'collection' },
          {
            key: 'fields',
            label: form.format === 'csv' ? 'CSV columns' : 'Fields (projection)',
            kind: 'text',
            placeholder: form.format === 'csv' ? 'auto-detected from the first 100 documents' : 'all fields',
            help: 'Comma-separated, dot notation for nested fields',
          },
          {
            key: 'limit',
            label: 'Limit',
            kind: 'number',
            hidden: form.scope !== 'collection',
            placeholder: 'no limit',
          },
          {
            key: 'output',
            label: form.scope === 'collection' ? 'Output file' : 'Output directory',
            kind: 'text',
            placeholder: 'auto: exports folder with timestamp',
          },
          { key: 'overwrite', label: 'Overwrite existing', kind: 'toggle' },
          { key: 'batchSize', label: 'Batch size', kind: 'number' },
        ]}
        values={form as unknown as Record<string, unknown>}
        onChange={(k, v) => setForm((f) => ({ ...f, [k]: v }))}
        focus={active}
        width={layout.width - 4}
        height={layout.height - (isJson ? 9 : 4)}
        onCancel={() => nav.back()}
        actions={[
          { key: 'run', label: 'Export', tone: 'primary', onPress: () => void run() },
          { key: 'browse', label: 'Choose folder…', onPress: () => setStep('browse') },
          { key: 'cancel', label: 'Cancel', onPress: () => nav.back() },
        ]}
      />
      {isJson && !layout.compact ? (
        <Box flexDirection="column" marginTop={1}>
          {JSON_MODE_EXPLANATION.map((l, i) => (
            <Text
              key={i}
              color={col(
                theme,
                l.startsWith('Plain') || l.startsWith('type') ? theme.colors.warning : theme.colors.muted,
              )}
              wrap="truncate-end"
            >
              {l}
            </Text>
          ))}
        </Box>
      ) : null}
    </Panel>
  );
}
