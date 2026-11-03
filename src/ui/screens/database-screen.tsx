import { Box, Text, useInput } from 'ink';
import React, { useMemo, useState } from 'react';
import { isSystemDatabase, type DatabaseSummary } from '../../database/database-manager.js';
import { Operations } from '../../security/permission-manager.js';
import { formatBytes, formatCount, formatDateTime, formatNumber } from '../../utils/formatting.js';
import { validateCollectionName, validateDatabaseName } from '../../utils/validation.js';
import { DataTable, type Column } from '../components/data-table.js';
import { useDialog } from '../components/dialog.js';
import { ErrorBox, Loading, Muted } from '../components/feedback.js';
import { Panel } from '../components/panel.js';
import { useScreenActive, useUi } from '../context.js';
import { useCachedAsync } from '../hooks/use-cached.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';
import { confirmOperation } from './confirm-operation.js';

type SortKey = 'name' | 'size' | 'collections' | 'documents';
const SORTS: SortKey[] = ['name', 'size', 'collections', 'documents'];

export function DatabaseScreen() {
  const { app, nav, theme, notify, notifyError } = useUi();
  const screenActive = useScreenActive();
  const layout = useLayout();
  const dialog = useDialog(layout.width);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('name');
  const [highlight, setHighlight] = useState<DatabaseSummary | undefined>();
  const result = useCachedAsync('databases', () => app.db().databases.listWithStats());
  const active = screenActive && !dialog.open;

  useHints(
    [
      { key: 'Enter', label: 'open' },
      { key: '/', label: 'search' },
      { key: 's', label: `sort:${sort}` },
      { key: 'r', label: 'refresh' },
      { key: 'c', label: 'create' },
      { key: 'D', label: 'drop' },
      { key: 'Esc', label: 'back' },
    ],
    [sort],
  );

  const rows = useMemo(() => {
    let list = result.data?.databases ?? [];
    if (search) list = list.filter((d) => d.name.toLowerCase().includes(search.toLowerCase()));
    const by: Record<SortKey, (d: DatabaseSummary) => number | string> = {
      name: (d) => d.name,
      size: (d) => -(d.stats?.storageSize ?? d.sizeOnDisk ?? 0),
      collections: (d) => -(d.stats?.collections ?? 0),
      documents: (d) => -(d.stats?.objects ?? 0),
    };
    return [...list].sort((a, b) => {
      // System databases (admin, config, local) always go last.
      const sys = Number(isSystemDatabase(a.name)) - Number(isSystemDatabase(b.name));
      if (sys !== 0) return sys;
      const va = by[sort](a);
      const vb = by[sort](b);
      return typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number);
    });
  }, [result.data, search, sort]);

  const createDatabase = async () => {
    const name = await dialog.prompt({
      title: 'Create database',
      label: 'Database name:',
      validate: validateDatabaseName,
      help: 'MongoDB creates a database together with its first collection.',
    });
    if (!name) return;
    const coll = await dialog.prompt({
      title: `Create database ${name}`,
      label: 'First collection:',
      validate: validateCollectionName,
    });
    if (!coll) return;
    if (!(await confirmOperation({ app, dialog, notify }, Operations.createCollection, `${name}.${coll}`)))
      return;
    try {
      await app.db().databases.create(name, coll);
      notify('success', `Created ${name}.${coll}`);
      app.events.emit('metadata:invalidated', { database: name });
      result.reload();
    } catch (e) {
      notifyError(e, 'Create failed');
    }
  };

  const dropDatabase = async (db: DatabaseSummary) => {
    if (isSystemDatabase(db.name)) {
      notify('error', 'System database', `"${db.name}" cannot be dropped from Mongo Terminal Pro.`);
      return;
    }
    const decision = app.permissions.check(Operations.dropDatabase);
    if (!decision.allowed) {
      notify('error', 'Read-only', decision.reason);
      return;
    }
    const ok = await dialog.confirm({
      title: `Drop database ${db.name}`,
      message: [
        `This permanently deletes ALL ${formatNumber(db.stats?.collections)} collections and ~${formatNumber(db.stats?.objects)} documents in "${db.name}".`,
        'This cannot be undone. Make a backup first.',
      ],
      danger: true,
      typeToConfirm: db.name,
    });
    if (!ok) return;
    try {
      await app.db().databases.drop(db.name);
      notify('success', `Dropped database ${db.name}`);
      app.events.emit('metadata:invalidated', { database: db.name });
      result.reload();
    } catch (e) {
      notifyError(e, 'Drop failed');
    }
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        if (search) setSearch('');
        else nav.back();
        return;
      }
      if (input === 'r') result.reload();
      else if (input === 's') setSort((s) => SORTS[(SORTS.indexOf(s) + 1) % SORTS.length] as SortKey);
      else if (input === '/')
        void dialog
          .prompt({ title: 'Search databases', label: 'Name contains:', initial: search })
          .then((v) => v !== undefined && setSearch(v));
      else if (input === 'c') void createDatabase();
      else if (input === 'D' && highlight) void dropDatabase(highlight);
    },
    { isActive: active },
  );

  if (dialog.open) return <Box justifyContent="center">{dialog.element}</Box>;
  if (result.loading && !result.data) return <Loading label="Discovering databases…" />;
  if (result.error) return <ErrorBox error={result.error} title="Could not list databases" />;

  const columns: Column<DatabaseSummary>[] = [
    {
      key: 'name',
      title: 'Database',
      render: (d) => d.name,
      minWidth: 14,
      color: (d) => (isSystemDatabase(d.name) ? theme.colors.muted : undefined),
    },
    {
      key: 'colls',
      title: 'Colls',
      width: 6,
      align: 'right',
      render: (d) => (d.stats ? formatNumber(d.stats.collections) : '—'),
      priority: 3,
    },
    {
      key: 'docs',
      title: 'Documents',
      width: 13,
      align: 'right',
      render: (d) => (d.stats ? formatCount(d.stats.objects, true) : '—'),
      priority: 4,
    },
    {
      key: 'data',
      title: 'Data',
      width: 10,
      align: 'right',
      render: (d) => formatBytes(d.stats?.dataSize),
      priority: 1,
    },
    {
      key: 'storage',
      title: 'Storage',
      width: 10,
      align: 'right',
      render: (d) => formatBytes(d.stats?.storageSize ?? d.sizeOnDisk),
      priority: 5,
    },
    {
      key: 'indexes',
      title: 'Indexes',
      width: 8,
      align: 'right',
      render: (d) => (d.stats ? formatNumber(d.stats.indexes) : d.statsError ? 'n/a' : '—'),
      priority: 2,
    },
  ];
  const total = result.data?.totalSize;
  return (
    <Box flexDirection="column">
      <Panel
        title={`Databases (${rows.length})${search ? ` matching "${search}"` : ''}`}
        right={result.cachedAt ? `updated ${formatDateTime(result.cachedAt).slice(11)}` : undefined}
        focus
      >
        {result.data?.warning ? (
          <Text color={col(theme, theme.colors.warning)}>{result.data.warning}</Text>
        ) : null}
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(d) => d.name}
          focus={active}
          height={layout.height - 6}
          width={layout.width - 4}
          onHighlight={(d) => setHighlight(d)}
          onSelect={(d) => {
            app.state.set({ database: d.name, collection: undefined });
            nav.push('collections', { db: d.name });
          }}
          emptyText="No databases visible to this user"
        />
      </Panel>
      <Muted>
        {total !== undefined ? `Total size on disk: ${formatBytes(total)} · ` : ''}~ = estimated from metadata
        (dbStats); no documents are scanned.
        {result.loading ? ' Refreshing…' : ''}
      </Muted>
    </Box>
  );
}
