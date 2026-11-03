import { Box, useInput } from 'ink';
import React, { useMemo, useState } from 'react';
import {
  filterAndSortCollections,
  type CollectionSortKey,
  type CollectionSummary,
  type CollectionType,
} from '../../database/collection-manager.js';
import { Operations } from '../../security/permission-manager.js';
import { formatBytes, formatCount, formatDateTime } from '../../utils/formatting.js';
import { validateCollectionName } from '../../utils/validation.js';
import { DataTable, type Column } from '../components/data-table.js';
import { useDialog } from '../components/dialog.js';
import { ErrorBox, Loading, Muted } from '../components/feedback.js';
import { Panel } from '../components/panel.js';
import { useScreenActive, useUi } from '../context.js';
import { useCachedAsync } from '../hooks/use-cached.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { confirmOperation } from './confirm-operation.js';

const SORTS: CollectionSortKey[] = ['name', 'count', 'size', 'indexes'];
const TYPE_FILTERS: (CollectionType[] | undefined)[] = [
  undefined,
  ['collection'],
  ['view'],
  ['timeseries'],
  ['system'],
];

export function CollectionListScreen({ params }: { params: { db: string } }) {
  const { app, nav, theme, notify, notifyError } = useUi();
  const screenActive = useScreenActive();
  const layout = useLayout();
  const dialog = useDialog(layout.width);
  const db = params.db;
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<CollectionSortKey>('name');
  const [descending, setDescending] = useState(false);
  const [typeFilter, setTypeFilter] = useState(0);
  const [highlight, setHighlight] = useState<CollectionSummary | undefined>();
  const result = useCachedAsync(
    `collections:${db}`,
    () => app.db().collections.list(db, { withStats: true }),
    [db],
  );
  const active = screenActive && !dialog.open;

  useHints(
    [
      { key: 'Enter', label: 'open' },
      { key: 'd', label: 'documents' },
      { key: '/', label: 'search' },
      { key: 's', label: `sort:${sort}${descending ? '↓' : '↑'}` },
      { key: 't', label: `type:${TYPE_FILTERS[typeFilter]?.join(',') ?? 'all'}` },
      { key: 'r', label: 'refresh' },
      { key: 'c', label: 'create' },
      { key: 'D', label: 'drop' },
      { key: 'Esc', label: 'back' },
    ],
    [sort, descending, typeFilter],
  );

  const rows = useMemo(
    () =>
      filterAndSortCollections(result.data ?? [], {
        search,
        sort,
        descending,
        types: TYPE_FILTERS[typeFilter],
      }),
    [result.data, search, sort, descending, typeFilter],
  );

  const create = async () => {
    const name = await dialog.prompt({
      title: `Create collection in ${db}`,
      label: 'Name:',
      validate: validateCollectionName,
    });
    if (!name) return;
    if (!(await confirmOperation({ app, dialog, notify }, Operations.createCollection, `${db}.${name}`)))
      return;
    try {
      await app.db().collections.create(db, name);
      notify('success', `Created ${db}.${name}`);
      result.reload();
    } catch (e) {
      notifyError(e, 'Create failed');
    }
  };

  const drop = async (c: CollectionSummary) => {
    const decision = app.permissions.check(Operations.dropCollection);
    if (!decision.allowed) {
      notify('warning', 'Read-only session', decision.reason);
      return;
    }
    const ok = await dialog.confirm({
      title: `Drop ${c.type} ${db}.${c.name}`,
      message: [
        `This permanently deletes the ${c.type}${c.count !== undefined ? ` and its ~${c.count} documents` : ''} and all of its indexes.`,
        'This cannot be undone.',
      ],
      danger: true,
      typeToConfirm: c.name,
    });
    if (!ok) return;
    try {
      await app.db().collections.drop(db, c.name);
      notify('success', `Dropped ${db}.${c.name}`);
      app.events.emit('metadata:invalidated', { database: db, collection: c.name });
      result.reload();
    } catch (e) {
      notifyError(e, 'Drop failed');
    }
  };

  const open = (c: CollectionSummary, screen: 'collection' | 'documents' = 'collection') => {
    app.state.set({ database: db, collection: c.name });
    nav.push(screen, { db, collection: c.name });
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        if (search) setSearch('');
        else nav.back();
        return;
      }
      if (input === 'r') result.reload();
      else if (input === 's') {
        if (descending) {
          setDescending(false);
          setSort((s) => SORTS[(SORTS.indexOf(s) + 1) % SORTS.length] as CollectionSortKey);
        } else setDescending(true);
      } else if (input === 't') setTypeFilter((t) => (t + 1) % TYPE_FILTERS.length);
      else if (input === '/')
        void dialog
          .prompt({ title: 'Search collections', label: 'Name contains:', initial: search })
          .then((v) => v !== undefined && setSearch(v));
      else if (input === 'c') void create();
      else if (input === 'D' && highlight) void drop(highlight);
      else if (input === 'd' && highlight) open(highlight, 'documents');
    },
    { isActive: active },
  );

  if (dialog.open) return <Box justifyContent="center">{dialog.element}</Box>;
  if (result.loading && !result.data) return <Loading label={`Discovering collections in ${db}…`} />;
  if (result.error) return <ErrorBox error={result.error} title={`Could not list collections in ${db}`} />;

  const columns: Column<CollectionSummary>[] = [
    {
      key: 'name',
      title: 'Collection',
      render: (c) => c.name,
      minWidth: 16,
      color: (c) =>
        c.type === 'view' ? theme.colors.info : c.type === 'system' ? theme.colors.muted : undefined,
    },
    { key: 'type', title: 'Type', width: 10, render: (c) => (c.capped ? 'capped' : c.type), priority: 2 },
    {
      key: 'count',
      title: 'Documents',
      width: 13,
      align: 'right',
      render: (c) => (c.type === 'view' ? 'n/a' : formatCount(c.count, c.countIsEstimate)),
      priority: 5,
    },
    {
      key: 'size',
      title: 'Storage',
      width: 10,
      align: 'right',
      render: (c) => formatBytes(c.storageSize),
      priority: 4,
    },
    {
      key: 'idx',
      title: 'Indexes',
      width: 7,
      align: 'right',
      render: (c) => (c.indexCount === undefined ? '—' : String(c.indexCount)),
      priority: 3,
    },
    {
      key: 'avg',
      title: 'Avg doc',
      width: 9,
      align: 'right',
      render: (c) => formatBytes(c.avgObjSize),
      priority: 1,
    },
  ];
  return (
    <Box flexDirection="column">
      <Panel
        title={`${db} · ${rows.length} collection(s)${search ? ` matching "${search}"` : ''}`}
        right={result.cachedAt ? `updated ${formatDateTime(result.cachedAt).slice(11)}` : undefined}
        focus
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(c) => c.name}
          focus={active}
          height={layout.height - 5}
          width={layout.width - 4}
          onHighlight={(c) => setHighlight(c)}
          onSelect={(c) => open(c)}
          emptyText={
            search ? 'No matching collections' : 'No collections in this database (press c to create one)'
          }
        />
      </Panel>
      <Muted>
        ~ = estimated from collection metadata. Views have no stored documents.{' '}
        {result.loading ? 'Refreshing…' : ''}
      </Muted>
    </Box>
  );
}
