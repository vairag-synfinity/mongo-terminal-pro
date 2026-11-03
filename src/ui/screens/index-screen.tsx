import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';
import { parseIndexKeys, type IndexInfo, type IndexUsage } from '../../database/index-manager.js';
import { Operations } from '../../security/permission-manager.js';
import { formatBytes, formatDateTime, formatNumber } from '../../utils/formatting.js';
import { parseMongoObject } from '../../utils/validation.js';
import { DataTable } from '../components/data-table.js';
import { useDialog } from '../components/dialog.js';
import { ErrorBox, Loading, Muted } from '../components/feedback.js';
import { Form } from '../components/form.js';
import { Panel } from '../components/panel.js';
import { useScreenActive, useUi } from '../context.js';
import { useAsync } from '../hooks/use-async.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';
import { confirmOperation } from './confirm-operation.js';

interface CreateForm {
  keys: string;
  name: string;
  unique: boolean;
  sparse: boolean;
  ttl: string;
  partial: string;
  hidden: boolean;
}

const EMPTY_FORM: CreateForm = {
  keys: '{ field: 1 }',
  name: '',
  unique: false,
  sparse: false,
  ttl: '',
  partial: '',
  hidden: false,
};

export function IndexScreen({ params }: { params: { db: string; collection: string } }) {
  const { app, nav, theme, symbols, notify, notifyError } = useUi();
  const screenActive = useScreenActive();
  const layout = useLayout();
  const dialog = useDialog(layout.width);
  const { db, collection } = params;
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [highlight, setHighlight] = useState<IndexInfo | undefined>();
  const [usage, setUsage] = useState<{ loading: boolean; data?: IndexUsage[]; message?: string }>({
    loading: false,
  });
  const [working, setWorking] = useState(false);
  const indexes = useAsync(async () => {
    const stats = await app
      .db()
      .collections.stats(db, collection)
      .catch(() => undefined);
    return app.db().indexes.list(db, collection, stats?.indexSizes);
  }, [db, collection, tick]);
  const active = screenActive && !dialog.open && !working;

  const loadUsage = async () => {
    setUsage({ loading: true });
    const res = await app.db().indexes.usage(db, collection);
    setUsage({ loading: false, data: res.usage, message: res.message });
  };

  const drop = async (idx: IndexInfo) => {
    if (idx.name === '_id_') {
      notify('warning', 'The _id index cannot be dropped');
      return;
    }
    const u = usage.data?.find((x) => x.name === idx.name);
    const ok = await confirmOperation(
      { app, dialog, notify },
      Operations.dropIndex,
      `Drop index "${idx.name}" (${idx.fields.join(', ')}) on ${db}.${collection}?`,
      [
        'Queries relying on it may become slow full collection scans.',
        ...(idx.unique ? ['It enforces UNIQUENESS — duplicates will be allowed after dropping.'] : []),
        ...(u
          ? [
              `Usage since ${u.since ? formatDateTime(u.since) : 'restart'}: ${formatNumber(u.ops)} operation(s).`,
            ]
          : ['Tip: press u first to see how often it is used.']),
        'Consider hiding the index first (hidden: true) to test the impact.',
      ],
      true,
    );
    if (!ok) return;
    setWorking(true);
    try {
      await app.db().indexes.drop(db, collection, idx.name);
      notify('success', `Dropped index ${idx.name}`);
      setTick((t) => t + 1);
    } catch (e) {
      notifyError(e, 'Drop index failed');
    } finally {
      setWorking(false);
    }
  };

  const create = async () => {
    let keys;
    let partial;
    try {
      keys = parseIndexKeys(form.keys);
      partial = form.partial.trim() ? parseMongoObject(form.partial, 'Partial filter') : undefined;
    } catch (e) {
      notifyError(e, 'Invalid index definition');
      return;
    }
    const ok = await confirmOperation(
      { app, dialog, notify },
      Operations.createIndex,
      `Create index ${JSON.stringify(keys)} on ${db}.${collection}?`,
      ['Index builds use server resources; on large collections they can take a while.'],
      true,
    );
    if (!ok) return;
    setWorking(true);
    try {
      const name = await app.db().indexes.create(db, collection, {
        keys,
        name: form.name.trim() || undefined,
        unique: form.unique,
        sparse: form.sparse,
        hidden: form.hidden,
        expireAfterSeconds: form.ttl ? Number(form.ttl) : undefined,
        partialFilterExpression: partial,
      });
      notify('success', `Created index ${name}`);
      setCreating(false);
      setForm(EMPTY_FORM);
      setTick((t) => t + 1);
    } catch (e) {
      notifyError(e, 'Create index failed');
    } finally {
      setWorking(false);
    }
  };

  useHints(
    creating
      ? [
          { key: 'Tab', label: 'next' },
          { key: 'Ctrl+S', label: 'create' },
          { key: 'Esc', label: 'cancel' },
        ]
      : [
          { key: 'c', label: 'create' },
          { key: 'd', label: 'drop' },
          { key: 'u', label: 'usage stats' },
          { key: 'r', label: 'refresh' },
          { key: 'Esc', label: 'back' },
        ],
    [creating],
  );

  useInput(
    (input, key) => {
      if (key.escape) return nav.back();
      if (input === 'c') {
        if (!app.permissions.check(Operations.createIndex).allowed)
          return notify('warning', 'Read-only session', 'Press W to enable write access first.');
        setCreating(true);
      } else if (input === 'd' && highlight) void drop(highlight);
      else if (input === 'u') void loadUsage();
      else if (input === 'r') setTick((t) => t + 1);
    },
    { isActive: active && !creating },
  );

  if (dialog.open) return <Box justifyContent="center">{dialog.element}</Box>;
  if (working) return <Loading label="Working…" />;
  if (creating) {
    return (
      <Panel title={`Create index on ${db}.${collection}`} focus>
        <Form
          fields={[
            {
              key: 'keys',
              label: 'Keys',
              kind: 'text',
              help: '1 / -1 / "text" / "2dsphere" / "hashed", e.g. { email: 1, createdAt: -1 }',
            },
            { key: 'name', label: 'Name', kind: 'text', placeholder: 'auto-generated' },
            { key: 'unique', label: 'Unique', kind: 'toggle' },
            { key: 'sparse', label: 'Sparse', kind: 'toggle' },
            {
              key: 'ttl',
              label: 'TTL (seconds)',
              kind: 'number',
              placeholder: 'no expiry',
              help: 'Single date field only',
            },
            { key: 'partial', label: 'Partial filter', kind: 'text', placeholder: '{ status: "active" }' },
            {
              key: 'hidden',
              label: 'Hidden',
              kind: 'toggle',
              help: 'Hidden indexes are maintained but not used by the planner',
            },
          ]}
          values={form as unknown as Record<string, unknown>}
          onChange={(k, v) => setForm((f) => ({ ...f, [k]: v }))}
          focus={active}
          width={layout.width - 4}
          onCancel={() => setCreating(false)}
          actions={[
            { key: 'create', label: 'Create index', tone: 'primary', onPress: () => void create() },
            { key: 'cancel', label: 'Cancel', onPress: () => setCreating(false) },
          ]}
        />
      </Panel>
    );
  }
  if (indexes.loading && !indexes.data) return <Loading label="Loading indexes…" />;
  if (indexes.error) return <ErrorBox error={indexes.error} />;
  const usageFor = (name: string) =>
    usage.data?.filter((u) => u.name === name).reduce((a, u) => a + u.ops, 0);
  return (
    <Box flexDirection="column">
      <Panel title={`Indexes · ${db}.${collection}`} right={`${indexes.data?.length ?? 0} index(es)`} focus>
        <DataTable
          columns={[
            { key: 'name', title: 'Name', minWidth: 12, render: (i) => i.name },
            { key: 'fields', title: 'Fields', minWidth: 14, render: (i) => i.fields.join(', ') },
            { key: 'type', title: 'Type', width: 9, render: (i) => i.type },
            {
              key: 'unique',
              title: 'Unique',
              width: 6,
              render: (i) => (i.unique ? symbols.check : ''),
              priority: 4,
            },
            {
              key: 'sparse',
              title: 'Sparse',
              width: 6,
              render: (i) => (i.sparse ? symbols.check : ''),
              priority: 2,
            },
            {
              key: 'ttl',
              title: 'TTL',
              width: 8,
              render: (i) => (i.ttlSeconds !== undefined ? `${i.ttlSeconds}s` : ''),
              priority: 3,
            },
            {
              key: 'size',
              title: 'Size',
              width: 9,
              align: 'right',
              render: (i) => formatBytes(i.sizeBytes),
              priority: 1,
            },
            {
              key: 'ops',
              title: 'Ops',
              width: 9,
              align: 'right',
              render: (i) => (usage.data ? formatNumber(usageFor(i.name) ?? 0) : '—'),
              priority: 0,
            },
          ]}
          rows={indexes.data ?? []}
          rowKey={(i) => i.name}
          focus={active}
          height={layout.height - 7}
          width={layout.width - 4}
          onHighlight={(i) => setHighlight(i)}
        />
      </Panel>
      {highlight ? (
        <Text wrap="truncate-end" color={col(theme, theme.colors.muted)}>
          {highlight.name}: {JSON.stringify(highlight.key)}
          {highlight.partialFilterExpression
            ? ` partial ${JSON.stringify(highlight.partialFilterExpression)}`
            : ''}
          {highlight.hidden ? ' · hidden' : ''}
          {highlight.collation ? ` · collation ${String(highlight.collation.locale)}` : ''}
        </Text>
      ) : null}
      <Muted>
        {usage.loading
          ? 'Loading $indexStats…'
          : (usage.message ??
            (usage.data
              ? 'Ops = accesses since the last server restart (per host, summed).'
              : 'Press u to load index usage ($indexStats).'))}
      </Muted>
    </Box>
  );
}
