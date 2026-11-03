import { Box, useInput } from 'ink';
import React, { useState } from 'react';
import { formatCount } from '../../utils/formatting.js';
import { ErrorBox, Loading } from '../components/feedback.js';
import { Panel } from '../components/panel.js';
import { SelectList } from '../components/select-list.js';
import { useAppState, useScreenActive, useUi, type ScreenName } from '../context.js';
import { useAsync } from '../hooks/use-async.js';
import { useHints, useLayout } from '../layouts/layout.js';

interface PickerParams {
  need: 'database' | 'collection';
  next: ScreenName;
  title?: string;
  db?: string;
}

/** Screens that need a real collection (views have no indexes and cannot be written). */
const WRITABLE_TARGETS: ScreenName[] = ['indexes', 'import'];

/** Chooses a database (and optionally a collection), then replaces itself with the target screen. */
export function PickerScreen({ params }: { params: PickerParams }) {
  const { app, nav, symbols } = useUi();
  const state = useAppState();
  const active = useScreenActive();
  const layout = useLayout();
  const [db, setDb] = useState<string | undefined>(params.db);

  const databases = useAsync(() => app.db().databases.list(), [], { enabled: !db });
  const collections = useAsync(() => app.db().collections.list(db as string, { withStats: false }), [db], {
    enabled: Boolean(db) && params.need === 'collection',
  });

  useHints(
    [
      { key: 'Enter', label: 'choose' },
      { key: '/', label: 'filter' },
      { key: 'Esc', label: db && !params.db ? 'databases' : 'back' },
    ],
    [db],
  );

  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (db && !params.db) setDb(undefined);
      else nav.back();
    },
    { isActive: active },
  );

  const choose = (database: string, collection?: string) => {
    app.state.set({ database, collection });
    nav.replace(params.next, { db: database, collection });
  };

  const height = layout.height - 3;
  const width = layout.width - 4;
  if (!db) {
    if (databases.loading) return <Loading label="Listing databases…" />;
    if (databases.error) return <ErrorBox error={databases.error} />;
    const list = databases.data?.databases ?? [];
    const initial = Math.max(
      0,
      list.findIndex((d) => d.name === state.database),
    );
    return (
      <Panel
        title={
          params.need === 'database'
            ? (params.title ?? 'Select database')
            : `Select database ${symbols.arrowRight} then collection`
        }
        focus
      >
        <SelectList
          items={list.map((d) => ({ key: d.name, label: d.name, value: d.name }))}
          initialIndex={initial}
          focus={active}
          height={height}
          width={width}
          searchable
          emptyText={databases.data?.warning ?? 'No databases'}
          onSelect={(item) => (params.need === 'database' ? choose(item.value) : setDb(item.value))}
        />
      </Panel>
    );
  }
  if (collections.loading) return <Loading label={`Listing collections in ${db}…`} />;
  if (collections.error) return <ErrorBox error={collections.error} />;
  const list = collections.data ?? [];
  const initial = Math.max(
    0,
    list.findIndex((c) => c.name === state.collection),
  );
  return (
    <Box flexDirection="column">
      <Panel title={`${params.title ?? 'Select collection'} · ${db}`} focus>
        <SelectList
          items={list.map((c) => {
            const viewBlocked = c.type === 'view' && WRITABLE_TARGETS.includes(params.next);
            return {
              key: c.name,
              label: c.name,
              value: c.name,
              hint:
                c.type !== 'collection'
                  ? c.type
                  : c.count === undefined
                    ? undefined
                    : formatCount(c.count, c.countIsEstimate),
              disabled: viewBlocked,
              disabledReason: 'view (read-only)',
            };
          })}
          initialIndex={initial}
          focus={active}
          height={height}
          width={width}
          searchable
          emptyText="No collections in this database"
          onSelect={(item) => choose(db, item.value)}
        />
      </Panel>
    </Box>
  );
}
