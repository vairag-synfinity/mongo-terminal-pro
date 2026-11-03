import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';
import type { SchemaAnalysis } from '../../database/schema-analyzer.js';
import { formatBytes, formatCount, formatNumber, truncate } from '../../utils/formatting.js';
import { documentSummary } from '../components/bson-format.js';
import { DataTable } from '../components/data-table.js';
import { ErrorBox, Loading, Muted } from '../components/feedback.js';
import { Panel } from '../components/panel.js';
import { SelectList, type SelectItem } from '../components/select-list.js';
import { useScreenActive, useUi, type ScreenName } from '../context.js';
import { useAsync } from '../hooks/use-async.js';
import { useCachedAsync } from '../hooks/use-cached.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';

interface Params {
  db: string;
  collection: string;
}

export function CollectionScreen({ params }: { params: Params }) {
  const { app, nav, theme, settings, symbols, notifyError } = useUi();
  const screenActive = useScreenActive();
  const layout = useLayout();
  const { db, collection } = params;
  const [schemaMode, setSchemaMode] = useState(false);
  const [exactCount, setExactCount] = useState<{ value?: number; loading: boolean; error?: string }>({
    loading: false,
  });

  const overview = useCachedAsync(
    `overview:${db}.${collection}`,
    async () => {
      const services = app.db();
      const [info, stats, indexes, sample] = await Promise.all([
        services.collections.list(db).then((l) => l.find((c) => c.name === collection)),
        services.collections.stats(db, collection).catch((e: unknown) => ({ error: e })),
        services.indexes.list(db, collection).catch(() => []),
        services.documents.sample(db, collection, 3, settings.queryTimeoutMs).catch(() => []),
      ]);
      return { info, stats, indexes, sample };
    },
    [db, collection],
  );
  const schema = useAsync<SchemaAnalysis>(
    () => app.db().schema.analyze(db, collection, settings.schemaSampleSize, settings.queryTimeoutMs),
    [db, collection],
    { enabled: schemaMode },
  );

  const runExactCount = async () => {
    setExactCount({ loading: true });
    try {
      const value = await app.db().collections.exactCount(db, collection, {}, settings.exactCountTimeoutMs);
      setExactCount({ value, loading: false });
    } catch (e) {
      setExactCount({ loading: false, error: (e as Error).message });
      notifyError(e, 'Exact count failed');
    }
  };

  useHints(
    schemaMode
      ? [
          { key: '↑↓', label: 'scroll' },
          { key: 'Esc', label: 'overview' },
        ]
      : [
          { key: 'Enter', label: 'run action' },
          { key: 'x', label: 'exact count' },
          { key: 'r', label: 'refresh' },
          { key: 'Esc', label: 'back' },
        ],
    [schemaMode],
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        if (schemaMode) setSchemaMode(false);
        else nav.back();
        return;
      }
      if (schemaMode) return;
      if (input === 'r') overview.reload();
      else if (input === 'x') void runExactCount();
    },
    { isActive: screenActive },
  );

  if (overview.loading && !overview.data) return <Loading label={`Loading ${db}.${collection}…`} />;
  if (overview.error) return <ErrorBox error={overview.error} />;
  const data = overview.data;
  const info = data?.info;
  const stats =
    data && !('error' in (data.stats ?? {}))
      ? (data.stats as Exclude<typeof data.stats, { error: unknown }>)
      : undefined;
  const isView = info?.type === 'view';

  if (schemaMode) {
    if (schema.loading) return <Loading label={`Sampling up to ${settings.schemaSampleSize} documents…`} />;
    if (schema.error) return <ErrorBox error={schema.error} title="Schema analysis failed" />;
    const s = schema.data;
    return (
      <Panel
        title={`Schema · ${db}.${collection}`}
        right={s ? `${s.sampleSize} sampled via ${s.method}` : undefined}
        focus
      >
        <DataTable
          columns={[
            {
              key: 'path',
              title: 'Field',
              render: (f) => `${'  '.repeat(Math.min(f.depth, 6))}${f.path.split('.').pop() ?? f.path}`,
              minWidth: 20,
            },
            {
              key: 'types',
              title: 'Types',
              render: (f) =>
                Object.entries(f.types)
                  .sort((a, b) => b[1] - a[1])
                  .map(([t, n]) => `${t}${Object.keys(f.types).length > 1 ? ` ${n}` : ''}`)
                  .join(', '),
              minWidth: 14,
            },
            {
              key: 'prob',
              title: 'Present',
              width: 8,
              align: 'right',
              render: (f) => `${Math.round(f.probability * 100)}%`,
            },
            { key: 'full', title: 'Path', render: (f) => f.path, priority: 1, minWidth: 16 },
          ]}
          rows={s?.fields ?? []}
          rowKey={(f) => f.path}
          focus={screenActive}
          height={layout.height - 4}
          width={layout.width - 4}
          emptyText="Collection is empty"
        />
      </Panel>
    );
  }

  const actions: {
    label: string;
    screen?: ScreenName;
    params?: Record<string, unknown>;
    run?: () => void;
    disabled?: boolean;
    reason?: string;
    desc: string;
  }[] = [
    { label: 'View Documents', screen: 'documents', desc: 'Paginated document browser' },
    {
      label: 'Search Documents',
      screen: 'documents',
      params: { focusFilter: true },
      desc: 'Open the browser with the filter focused',
    },
    {
      label: 'Insert Document',
      screen: 'documents',
      params: { insert: true },
      disabled: isView,
      reason: 'views are read-only',
      desc: 'Opens the editor with a new document',
    },
    { label: 'Query Builder', screen: 'query', desc: 'find / count / distinct / update / delete' },
    { label: 'Run Aggregation', screen: 'aggregation', desc: 'Pipeline builder for this collection' },
    {
      label: 'Analyze Schema',
      run: () => setSchemaMode(true),
      desc: `Infer fields and types from a $sample of ${settings.schemaSampleSize} documents`,
    },
    {
      label: 'Manage Indexes',
      screen: 'indexes',
      disabled: isView,
      reason: 'views have no indexes',
      desc: 'View, create, drop indexes and usage',
    },
    {
      label: 'Import Documents',
      screen: 'import',
      disabled: isView,
      reason: 'views are read-only',
      desc: 'JSON / CSV / BSON into this collection',
    },
    { label: 'Export Documents', screen: 'export', desc: 'JSON / CSV / BSON from this collection' },
  ];
  const items: SelectItem<(typeof actions)[number]>[] = actions.map((a, i) => ({
    key: a.label,
    label: a.label,
    value: a,
    shortcut: String(i + 1),
    disabled: a.disabled,
    disabledReason: a.reason,
    description: a.desc,
  }));

  const leftWidth = layout.wide ? 42 : layout.width - 2;
  const sampleHeight = Math.max(0, Math.min(3, layout.height - 22));
  return (
    <Box flexDirection={layout.wide ? 'row' : 'column'}>
      <Panel title="Actions" focus width={leftWidth}>
        <SelectList
          items={items}
          focus={screenActive}
          height={
            layout.wide ? layout.height - 3 : Math.min(items.length + 1, Math.max(4, layout.height - 14))
          }
          width={leftWidth - 4}
          onSelect={(item) => {
            if (item.value.run) item.value.run();
            else if (item.value.screen)
              nav.push(item.value.screen, { db, collection, ...(item.value.params ?? {}) });
          }}
        />
      </Panel>
      <Box flexDirection="column" flexGrow={1}>
        <Panel title={`${db}.${collection}`} right={info?.type}>
          <Text>
            Documents: <Text bold>{isView ? 'n/a (view)' : formatCount(stats?.count, true)}</Text>
            {exactCount.loading ? (
              <Text color={col(theme, theme.colors.muted)}> counting…</Text>
            ) : exactCount.value !== undefined ? (
              <Text color={col(theme, theme.colors.success)}> exact: {formatNumber(exactCount.value)}</Text>
            ) : (
              <Text color={col(theme, theme.colors.muted)}> (x = exact count)</Text>
            )}
          </Text>
          {!isView ? (
            <>
              <Text>
                Data size: {formatBytes(stats?.size)} Storage: {formatBytes(stats?.storageSize)} Avg doc:{' '}
                {formatBytes(stats?.avgObjSize)}
              </Text>
              <Text>
                Indexes: {data?.indexes.length ?? '—'} ({formatBytes(stats?.totalIndexSize)})
                {stats?.capped || info?.capped ? '   capped' : ''}
              </Text>
            </>
          ) : (
            <Text wrap="truncate-end">
              View on: {String(info?.options.viewOn ?? '?')} pipeline stages:{' '}
              {Array.isArray(info?.options.pipeline) ? info.options.pipeline.length : 0}
            </Text>
          )}
          {info?.options.validator ? (
            <Text color={col(theme, theme.colors.info)}>Has a JSON schema validator</Text>
          ) : null}
          {info?.options.timeseries ? (
            <Text>
              Time series: timeField={String((info.options.timeseries as { timeField?: string }).timeField)}
            </Text>
          ) : null}
        </Panel>
        {!layout.compact && data?.indexes.length ? (
          <Panel title="Indexes">
            {data.indexes.slice(0, 4).map((i) => (
              <Text key={i.name} wrap="truncate-end">
                {symbols.dot} {i.name}{' '}
                <Text color={col(theme, theme.colors.muted)}>
                  {i.fields.join(', ')} · {i.type}
                  {i.unique ? ' · unique' : ''}
                  {i.ttlSeconds !== undefined ? ` · TTL ${i.ttlSeconds}s` : ''}
                </Text>
              </Text>
            ))}
            {data.indexes.length > 4 ? (
              <Muted>… {data.indexes.length - 4} more (Manage Indexes)</Muted>
            ) : null}
          </Panel>
        ) : null}
        {sampleHeight > 0 && data?.sample.length ? (
          <Panel title="Sample documents">
            {data.sample.slice(0, sampleHeight).map((d, i) => (
              <Text key={i} wrap="truncate-end">
                {truncate(documentSummary(d, layout.width - leftWidth - 8), layout.width - leftWidth - 6)}
              </Text>
            ))}
          </Panel>
        ) : null}
      </Box>
    </Box>
  );
}
