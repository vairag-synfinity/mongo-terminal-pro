import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';
import type { QueryOperation, StoredQuery } from '../../config/configuration.js';
import {
  parseQuery,
  WRITE_OPERATIONS,
  type QueryInput,
  type QueryResult,
} from '../../database/query-manager.js';
import { formatDateTime, formatDuration, formatNumber, truncate } from '../../utils/formatting.js';
import { useDialog } from '../components/dialog.js';
import { Loading, Muted } from '../components/feedback.js';
import { Form, type FieldDef } from '../components/form.js';
import { JsonView } from '../components/json-view.js';
import { Panel } from '../components/panel.js';
import { SelectList } from '../components/select-list.js';
import { useAppState, useScreenActive, useUi } from '../context.js';
import { useAsync } from '../hooks/use-async.js';
import { useDraft } from '../hooks/use-draft.js';
import { useNamespaceSuggestions } from '../hooks/use-namespaces.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';

interface Params {
  db?: string;
  collection?: string;
}

interface QueryForm {
  database: string;
  collection: string;
  operation: QueryOperation;
  filter: string;
  projection: string;
  sort: string;
  limit: string;
  skip: string;
  update: string;
  distinctField: string;
}

type View =
  | { kind: 'form' }
  | { kind: 'results'; result: QueryResult; warnings: string[] }
  | { kind: 'history' }
  | { kind: 'saved' };

const OPERATIONS: QueryOperation[] = [
  'find',
  'findOne',
  'count',
  'distinct',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
];

export function QueryScreen({ params }: { params: Params }) {
  const { app, nav, theme, settings, symbols, notify, notifyError } = useUi();
  const state = useAppState();
  const screenActive = useScreenActive();
  const layout = useLayout();
  const dialog = useDialog(layout.width);
  const [form, setForm] = useDraft<QueryForm>('query:form', () => ({
    database: params.db ?? state.database ?? '',
    collection: params.collection ?? state.collection ?? '',
    operation: 'find',
    filter: '{}',
    projection: '',
    sort: '',
    limit: '20',
    skip: '0',
    update: '{ $set: { } }',
    distinctField: '',
  }));
  const ns = useNamespaceSuggestions(form.database);
  const [view, setView] = useState<View>({ kind: 'form' });
  const [running, setRunning] = useState(false);
  const [listTick, setListTick] = useState(0);
  const active = screenActive && !dialog.open && !running;

  // Navigating here from a collection always targets that collection.
  React.useEffect(() => {
    if (
      params.db &&
      params.collection &&
      (form.database !== params.db || form.collection !== params.collection)
    ) {
      setForm((f) => ({ ...f, database: params.db as string, collection: params.collection as string }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const history = useAsync(() => app.history.listHistory(), [view.kind === 'history', listTick], {
    enabled: view.kind === 'history',
  });
  const saved = useAsync(() => app.history.listSavedQueries(), [view.kind === 'saved', listTick], {
    enabled: view.kind === 'saved',
  });

  const limits = { resultLimit: settings.queryResultLimit, timeoutMs: settings.queryTimeoutMs };
  const input = (): QueryInput => ({
    database: form.database.trim(),
    collection: form.collection.trim(),
    operation: form.operation,
    filter: form.filter,
    projection: form.projection,
    sort: form.sort,
    update: form.update,
    distinctField: form.distinctField,
    limit: Number(form.limit || 0),
    skip: Number(form.skip || 0),
  });

  const validate = () => {
    try {
      const q = parseQuery(input(), limits);
      notify('success', 'Query is valid', q.warnings.join('\n') || undefined);
    } catch (e) {
      notifyError(e, 'Query is not valid');
    }
  };

  const run = async () => {
    let q;
    try {
      q = parseQuery(input(), limits);
    } catch (e) {
      notifyError(e, 'Query is not valid');
      return;
    }
    if (q.permission) {
      const decision = app.permissions.check(q.permission);
      if (!decision.allowed) {
        notify('warning', 'Read-only session', decision.reason);
        return;
      }
      setRunning(true);
      const affected = await app
        .db()
        .queries.previewAffected(q, Math.min(settings.exactCountTimeoutMs, settings.queryTimeoutMs));
      setRunning(false);
      const many = q.operation === 'updateMany' || q.operation === 'deleteMany';
      const verb = q.operation.startsWith('delete') ? 'delete' : 'update';
      const ok = await dialog.confirm({
        title: `${q.operation} on ${q.database}.${q.collection}`,
        message: [
          affected === undefined
            ? `Could not count matching documents in time.`
            : `This will ${verb} ${many ? formatNumber(affected) : Math.min(1, affected)} document(s).`,
          ...q.warnings,
          `Filter: ${truncate(form.filter, 200)}`,
          ...(q.update ? [`Update: ${truncate(form.update, 200)}`] : []),
          'This cannot be undone.',
        ],
        danger: true,
        confirmLabel: `Yes, ${verb}`,
        typeToConfirm:
          decision.confirmation === 'type-name' || (many && q.affectsAll)
            ? (app.permissions.connectionName ?? q.collection)
            : undefined,
      });
      if (!ok) return;
    }
    setRunning(true);
    try {
      const result = await app.db().queries.execute(q, limits);
      await app.history.addHistory({
        database: q.database,
        collection: q.collection,
        operation: q.operation,
        filter: form.filter,
        projection: form.projection,
        sort: form.sort,
        update: form.update,
        distinctField: form.distinctField,
        limit: q.limit,
        skip: q.skip,
      });
      app.state.set({ database: q.database, collection: q.collection });
      if (WRITE_OPERATIONS.includes(q.operation))
        app.events.emit('metadata:invalidated', { database: q.database, collection: q.collection });
      setView({ kind: 'results', result, warnings: q.warnings });
    } catch (e) {
      notifyError(e, 'Query failed');
    } finally {
      setRunning(false);
    }
  };

  const saveQuery = async () => {
    const name = await dialog.prompt({
      title: 'Save query',
      label: 'Name:',
      validate: (v) => (v.trim() ? undefined : 'Name is required'),
    });
    if (!name) return;
    await app.history.saveQuery({
      name: name.trim(),
      database: form.database,
      collection: form.collection,
      operation: form.operation,
      filter: form.filter,
      projection: form.projection,
      sort: form.sort,
      update: form.update,
      distinctField: form.distinctField,
      limit: Number(form.limit || 0),
      skip: Number(form.skip || 0),
    });
    notify('success', `Saved query "${name.trim()}"`);
  };

  const load = (q: StoredQuery) => {
    setForm({
      database: q.database,
      collection: q.collection,
      operation: q.operation,
      filter: q.filter,
      projection: q.projection,
      sort: q.sort,
      limit: String(q.limit),
      skip: String(q.skip),
      update: q.update || '{ $set: { } }',
      distinctField: q.distinctField,
    });
    setView({ kind: 'form' });
  };

  useHints(
    view.kind === 'form'
      ? [
          { key: 'Tab', label: 'next field' },
          { key: 'Ctrl+R', label: 'run' },
          { key: 'Ctrl+S', label: 'run' },
          { key: 'Esc', label: 'back' },
        ]
      : view.kind === 'results'
        ? [
            { key: '↑↓', label: 'scroll' },
            { key: '←→', label: 'collapse/expand' },
            { key: 'x', label: 'export' },
            { key: 'Esc', label: 'edit query' },
          ]
        : [
            { key: 'Enter', label: 'load' },
            ...(view.kind === 'saved'
              ? [{ key: 'd', label: 'delete' }]
              : [{ key: 'C', label: 'clear history' }]),
            { key: 'Esc', label: 'back' },
          ],
    [view.kind],
  );

  useInput(
    (inputKey, key) => {
      if (view.kind === 'form') {
        if (key.ctrl && inputKey === 'r') void run();
        return;
      }
      if (key.escape) return setView({ kind: 'form' });
      if (view.kind === 'results' && inputKey === 'x' && form.operation === 'find') {
        nav.push('export', {
          db: form.database,
          collection: form.collection,
          filter: form.filter,
          sort: form.sort,
          projection: form.projection,
        });
      }
      if (view.kind === 'history' && inputKey === 'C') {
        void app.history.clearHistory().then(() => setListTick((t) => t + 1));
      }
    },
    { isActive: active },
  );

  if (dialog.open) return <Box justifyContent="center">{dialog.element}</Box>;
  if (running)
    return (
      <Loading label={`Running ${form.operation} (timeout ${formatDuration(settings.queryTimeoutMs)})…`} />
    );

  if (view.kind === 'results') {
    const r = view.result;
    const value: unknown =
      r.operation === 'find'
        ? r.documents
        : r.operation === 'findOne'
          ? (r.documents?.[0] ?? null)
          : r.operation === 'count'
            ? { count: r.count }
            : r.operation === 'distinct'
              ? { distinctValues: r.count, values: r.values }
              : r.deleted !== undefined
                ? { deletedCount: r.deleted }
                : { matchedCount: r.matched, modifiedCount: r.modified, upsertedId: r.upsertedId ?? null };
    const summary =
      r.operation === 'find'
        ? `${formatNumber(r.documents?.length ?? 0)} document(s)${r.truncated ? ` (limit ${r.effectiveLimit} reached — more exist)` : ''}`
        : r.operation === 'findOne'
          ? r.documents?.length
            ? '1 document'
            : 'no match'
          : r.operation === 'count'
            ? `count = ${formatNumber(r.count)}`
            : r.operation === 'distinct'
              ? `${formatNumber(r.count)} distinct value(s)${r.truncated ? ' (display truncated)' : ''}`
              : r.deleted !== undefined
                ? `${formatNumber(r.deleted)} deleted`
                : `${formatNumber(r.matched)} matched, ${formatNumber(r.modified)} modified`;
    return (
      <Panel
        title={`Results · ${form.operation} ${form.database}.${form.collection}`}
        right={`${summary} · ${formatDuration(r.durationMs)}`}
        focus
      >
        {view.warnings.map((w, i) => (
          <Text key={i} color={col(theme, theme.colors.warning)}>
            {symbols.warning} {w}
          </Text>
        ))}
        <JsonView
          value={value}
          focus={active}
          height={layout.height - 4 - view.warnings.length}
          width={layout.width - 4}
          initialDepth={1}
        />
      </Panel>
    );
  }

  if (view.kind === 'history' || view.kind === 'saved') {
    const data = view.kind === 'history' ? history : saved;
    if (data.loading) return <Loading />;
    const list = data.data ?? [];
    return (
      <Panel title={view.kind === 'history' ? 'Query history' : 'Saved queries'} focus>
        <SelectList
          items={list.map((q) => ({
            key: q.id,
            label: `${q.name ? `${q.name}: ` : ''}${q.operation} ${q.database}.${q.collection} ${q.filter}`,
            value: q,
            hint: q.executedAt ? formatDateTime(q.executedAt) : formatDateTime(q.createdAt),
          }))}
          focus={active}
          height={layout.height - 4}
          width={layout.width - 4}
          searchable
          showDescription={false}
          emptyText={view.kind === 'history' ? 'No queries executed yet' : 'No saved queries'}
          onSelect={(item) => load(item.value)}
          onKey={(k, item) => {
            if (k === 'd' && item && view.kind === 'saved')
              void app.history.deleteSavedQuery(item.value.id).then(() => setListTick((t) => t + 1));
          }}
        />
      </Panel>
    );
  }

  const op = form.operation;
  const fields: FieldDef[] = [
    {
      key: 'database',
      label: 'Database',
      kind: 'combo',
      suggestions: ns.databases,
      suggestionsLoading: ns.loadingDatabases,
      newValueLabel: 'not found',
    },
    {
      key: 'collection',
      label: 'Collection',
      kind: 'combo',
      suggestions: ns.collections,
      suggestionsLoading: ns.loadingCollections,
      newValueLabel: 'not found',
    },
    {
      key: 'operation',
      label: 'Operation',
      kind: 'select',
      options: OPERATIONS.map((o) => ({ label: o, value: o })),
      help: 'update*/delete* require write access and confirmation',
    },
    {
      key: 'filter',
      label: 'Filter',
      kind: 'textarea',
      rows: layout.compact ? 2 : 4,
      placeholder: '{ status: "active", age: { $gte: 18 } }',
    },
    {
      key: 'projection',
      label: 'Projection',
      kind: 'text',
      hidden: !['find', 'findOne'].includes(op),
      placeholder: '{ name: 1, _id: 0 }',
    },
    {
      key: 'sort',
      label: 'Sort',
      kind: 'text',
      hidden: !['find', 'findOne'].includes(op),
      placeholder: '{ createdAt: -1 }',
    },
    {
      key: 'limit',
      label: 'Limit',
      kind: 'number',
      hidden: !['find', 'distinct'].includes(op),
      help: `0 = default; capped at ${settings.queryResultLimit} (Settings)`,
    },
    { key: 'skip', label: 'Skip', kind: 'number', hidden: !['find', 'findOne', 'count'].includes(op) },
    { key: 'distinctField', label: 'Distinct field', kind: 'text', hidden: op !== 'distinct' },
    {
      key: 'update',
      label: 'Update',
      kind: 'textarea',
      rows: layout.compact ? 2 : 3,
      hidden: !['updateOne', 'updateMany'].includes(op),
      placeholder: '{ $set: { status: "archived" } }',
    },
  ];
  return (
    <Panel
      title="Query builder"
      right={`timeout ${formatDuration(settings.queryTimeoutMs)} · max ${settings.queryResultLimit} docs`}
      focus
    >
      <Form
        fields={fields}
        values={form as unknown as Record<string, unknown>}
        onChange={(k, v) => setForm((f) => ({ ...f, [k]: v }))}
        focus={active}
        width={layout.width - 4}
        height={layout.height - 5}
        labelWidth={16}
        onCancel={() => nav.back()}
        actions={[
          {
            key: 'run',
            label: 'Run',
            tone: WRITE_OPERATIONS.includes(op) ? 'danger' : 'primary',
            onPress: () => void run(),
          },
          { key: 'validate', label: 'Validate', onPress: validate },
          { key: 'save', label: 'Save', onPress: () => void saveQuery() },
          { key: 'history', label: 'History', onPress: () => setView({ kind: 'history' }) },
          { key: 'saved', label: 'Saved', onPress: () => setView({ kind: 'saved' }) },
        ]}
        footer={<Muted>Shell syntax accepted: ObjectId("…"), ISODate("…"), /regex/i, unquoted keys.</Muted>}
      />
    </Panel>
  );
}
