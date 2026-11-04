import { Box, Text, useInput } from 'ink';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CollectionSummary } from '../../database/collection-manager.js';
import { isSystemDatabase } from '../../database/database-manager.js';
import { truncate } from '../../utils/formatting.js';
import { visibleWindow } from '../../utils/pagination.js';
import { useUi } from '../context.js';
import { useMouseWheel } from '../hooks/use-mouse.js';
import { col } from '../themes/theme.js';
import { TextInput } from './text-input.js';

export interface TreeSelection {
  db?: string;
  collection?: string;
}

interface TreeRow {
  kind: 'db' | 'coll' | 'info';
  key: string;
  db: string;
  collection?: CollectionSummary;
  text?: string;
}

export interface ExplorerTreeProps {
  focus: boolean;
  width: number;
  height: number;
  selected: TreeSelection;
  onOpenDatabase(db: string): void;
  onOpenCollection(db: string, collection: CollectionSummary): void;
  /** Extra single-key shortcuts (menu, backup, …); return true when handled. */
  /** `db` is the database of the highlighted row (if any). */
  onKey?(input: string, db?: string): boolean | void;
  /** Esc when no filter is active. */
  onEscape?(): void;
}

/**
 * Compass-style navigation tree: databases with their collections underneath.
 * ↑↓ move · → expand / open · ← collapse / parent · Enter open · / filter · r refresh.
 * Collections are loaded lazily when a database is expanded (metadata only, no counts).
 */
export function ExplorerTree({
  focus,
  width,
  height,
  selected,
  onOpenDatabase,
  onOpenCollection,
  onKey,
  onEscape,
}: ExplorerTreeProps) {
  const { app, theme, symbols, notifyError, drafts } = useUi();
  const [databases, setDatabases] = useState<string[] | undefined>();
  const [warning, setWarning] = useState<string | undefined>();
  const [collections, setCollections] = useState<Record<string, CollectionSummary[] | 'loading' | 'error'>>(
    {},
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(selected.db ? [selected.db] : []));
  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const offset = useRef(0);
  const initialised = useRef(false);

  const loadCollections = useCallback(
    async (db: string) => {
      setCollections((c) => ({ ...c, [db]: 'loading' }));
      try {
        const list = await app.db().collections.list(db, { withStats: false });
        setCollections((c) => ({ ...c, [db]: list.filter((x) => x.type !== 'system') }));
      } catch (e) {
        setCollections((c) => ({ ...c, [db]: 'error' }));
        notifyError(e, `Cannot list collections of ${db}`);
      }
    },
    [app, notifyError],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await app.db().databases.list();
        if (!alive) return;
        setDatabases(res.databases.map((d) => d.name));
        setWarning(res.warning);
        // Reload collections of expanded databases.
        for (const db of expanded) void loadCollections(db);
      } catch (e) {
        if (alive) {
          setDatabases([]);
          notifyError(e, 'Cannot list databases');
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, reloadTick]);

  // Refresh after creates/drops anywhere in the app.
  useEffect(
    () =>
      app.events.on('metadata:invalidated', () => {
        for (const k of [...drafts.keys()]) if (k.startsWith('cache:')) drafts.delete(k);
        setReloadTick((t) => t + 1);
      }),
    [app, drafts],
  );

  // Searching needs collection names of databases that were never expanded (metadata only).
  useEffect(() => {
    if (!filter.trim() || !databases) return;
    for (const db of databases.slice(0, 50)) if (collections[db] === undefined) void loadCollections(db);
  }, [filter, databases, collections, loadCollections]);

  const rows = useMemo(() => {
    const out: TreeRow[] = [];
    const q = filter.trim().toLowerCase();
    for (const db of databases ?? []) {
      const colls = collections[db];
      const loaded = Array.isArray(colls) ? colls : [];
      const dbMatches = !q || db.toLowerCase().includes(q);
      const collMatches = q ? loaded.filter((c) => c.name.toLowerCase().includes(q)) : loaded;
      if (!dbMatches && collMatches.length === 0) continue;
      out.push({ kind: 'db', key: `db:${db}`, db });
      const open = expanded.has(db) || (q !== '' && collMatches.length > 0);
      if (!open) continue;
      if (colls === 'loading') out.push({ kind: 'info', key: `info:${db}`, db, text: 'loading…' });
      else if (colls === 'error') out.push({ kind: 'info', key: `info:${db}`, db, text: 'not authorised' });
      else if (loaded.length === 0) out.push({ kind: 'info', key: `info:${db}`, db, text: 'no collections' });
      // A matching database shows all its collections; otherwise only the matching ones.
      for (const c of dbMatches ? loaded : collMatches) {
        out.push({ kind: 'coll', key: `coll:${db}.${c.name}`, db, collection: c });
      }
    }
    return out;
  }, [databases, collections, expanded, filter]);

  // Put the cursor on the current selection the first time data arrives.
  useEffect(() => {
    if (initialised.current || rows.length === 0) return;
    initialised.current = true;
    const target = rows.findIndex((r) =>
      selected.collection
        ? r.kind === 'coll' && r.db === selected.db && r.collection?.name === selected.collection
        : r.kind === 'db' && r.db === selected.db,
    );
    if (target >= 0) setCursor(target);
  }, [rows, selected]);

  useEffect(() => {
    if (cursor >= rows.length && rows.length > 0) setCursor(rows.length - 1);
  }, [rows.length, cursor]);

  const current = rows[cursor];

  const toggle = (db: string, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const shouldOpen = open ?? !next.has(db);
      if (shouldOpen) {
        next.add(db);
        if (!Array.isArray(collections[db])) void loadCollections(db);
      } else next.delete(db);
      return next;
    });
  };

  const move = (d: number) => setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + d)));
  useMouseWheel((d) => move(d * 3), focus && !filtering);

  useInput(
    (input, key) => {
      if (filtering) {
        if (key.escape) {
          setFiltering(false);
          setFilter('');
        } else if (key.return || key.downArrow) setFiltering(false);
        return;
      }
      if (key.escape) {
        if (filter) setFilter('');
        else onEscape?.();
        return;
      }
      if (key.upArrow || input === 'k') return move(-1);
      if (key.downArrow || input === 'j') return move(1);
      if (key.pageUp) return move(-(height - 3));
      if (key.pageDown) return move(height - 3);
      if (key.home || input === 'g') return setCursor(0);
      if (key.end || input === 'G') return setCursor(Math.max(0, rows.length - 1));
      if (input === '/') return setFiltering(true);
      if (input === 'r') {
        setCollections({});
        setReloadTick((t) => t + 1);
        return;
      }
      if (!current) {
        onKey?.(input);
        return;
      }
      if (key.rightArrow || input === 'l') {
        if (current.kind === 'db') {
          if (!expanded.has(current.db)) toggle(current.db, true);
          else move(1);
        } else if (current.kind === 'coll' && current.collection)
          onOpenCollection(current.db, current.collection);
        return;
      }
      if (key.leftArrow || input === 'h') {
        if (current.kind === 'db') toggle(current.db, false);
        else {
          const parent = rows.findIndex((r) => r.kind === 'db' && r.db === current.db);
          if (parent >= 0) setCursor(parent);
        }
        return;
      }
      if (key.return) {
        if (current.kind === 'db') {
          toggle(current.db, true);
          onOpenDatabase(current.db);
        } else if (current.kind === 'coll' && current.collection)
          onOpenCollection(current.db, current.collection);
        return;
      }
      onKey?.(input, current.db);
    },
    { isActive: focus },
  );

  const listHeight = Math.max(1, height - (filtering || filter ? 1 : 0) - 1);
  const win = visibleWindow(
    rows.length,
    Math.min(cursor, Math.max(0, rows.length - 1)),
    listHeight,
    offset.current,
  );
  offset.current = win.start;
  const textWidth = Math.max(6, width - 1);
  const collIcon = (c: CollectionSummary) =>
    c.type === 'view'
      ? symbols.unicode
        ? '◇'
        : 'v'
      : c.type === 'timeseries'
        ? symbols.unicode
          ? '◷'
          : 't'
        : symbols.unicode
          ? '▤'
          : '-';

  return (
    <Box flexDirection="column" width={width}>
      {filtering || filter ? (
        <Box>
          <Text color={col(theme, theme.colors.accent)}>/ </Text>
          <TextInput
            value={filter}
            onChange={setFilter}
            focus={focus && filtering}
            width={width - 3}
            placeholder="filter databases & collections"
          />
        </Box>
      ) : null}
      {databases === undefined ? (
        <Text color={col(theme, theme.colors.muted)}>Loading databases…</Text>
      ) : null}
      {databases?.length === 0 ? (
        <Text color={col(theme, theme.colors.muted)}>{truncate(warning ?? 'No databases', textWidth)}</Text>
      ) : null}
      {rows.slice(win.start, win.end).map((row, i) => {
        const index = win.start + i;
        const isCursor = focus && index === cursor;
        const isSelected =
          row.kind === 'coll'
            ? row.db === selected.db && row.collection?.name === selected.collection
            : row.kind === 'db' && row.db === selected.db && !selected.collection;
        let label: string;
        let color = theme.colors.text;
        if (row.kind === 'db') {
          const open =
            expanded.has(row.db) || (filter !== '' && rows.some((r) => r.kind === 'coll' && r.db === row.db));
          label = `${open ? symbols.expanded : symbols.collapsed} ${row.db}`;
          color = isSystemDatabase(row.db) ? theme.colors.muted : theme.colors.info;
        } else if (row.kind === 'coll' && row.collection) {
          label = `   ${collIcon(row.collection)} ${row.collection.name}`;
          if (row.collection.type === 'view') color = theme.colors.json.special;
        } else {
          label = `     ${row.text ?? ''}`;
          color = theme.colors.muted;
        }
        return (
          <Box key={row.key} flexShrink={0}>
            <Text
              inverse={isCursor && theme.noColor}
              backgroundColor={isCursor && !theme.noColor ? theme.colors.selectionBg : undefined}
              color={col(theme, isCursor && !theme.noColor ? theme.colors.selectionFg : color)}
              bold={isSelected || row.kind === 'db'}
              underline={isSelected && !isCursor}
            >
              {` ${truncate(label, textWidth - 1)}`.padEnd(textWidth)}
            </Text>
          </Box>
        );
      })}
      <Text color={col(theme, theme.colors.muted)}>
        {truncate(
          `${databases?.length ?? 0} database(s)${rows.length > listHeight ? ` · ${cursor + 1}/${rows.length}` : ''}`,
          textWidth,
        )}
      </Text>
    </Box>
  );
}
