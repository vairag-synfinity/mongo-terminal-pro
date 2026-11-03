import { EJSON } from '../../utils/bson.js';
import { Box, Text, useApp as useInkApp, useInput } from 'ink';
import type { Document, Sort } from 'mongodb';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import React, { useEffect, useRef, useState } from 'react';
import type { DocumentPage } from '../../database/document-manager.js';
import { Operations } from '../../security/permission-manager.js';
import { copyToClipboard } from '../../utils/clipboard.js';
import { editInExternalEditor, resolveEditor } from '../../utils/external-editor.js';
import { formatNumber, timestampForFilename, truncate } from '../../utils/formatting.js';
import { describePage, KeysetAnchors, MAX_PAGE_SIZE } from '../../utils/pagination.js';
import { parseMongoObject } from '../../utils/validation.js';
import { documentSummary, formatScalar, toShellString } from '../components/bson-format.js';
import { useDialog } from '../components/dialog.js';
import { ErrorBox, Loading, Muted } from '../components/feedback.js';
import { JsonView } from '../components/json-view.js';
import { Panel } from '../components/panel.js';
import { SelectList } from '../components/select-list.js';
import { TextArea } from '../components/text-area.js';
import { TextInput } from '../components/text-input.js';
import { useScreenActive, useUi } from '../context.js';
import { useAsync } from '../hooks/use-async.js';
import { useDraft } from '../hooks/use-draft.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';
import { confirmOperation } from './confirm-operation.js';

interface Params {
  db: string;
  collection: string;
  focusFilter?: boolean;
  insert?: boolean;
  filter?: string;
}

type Mode = { kind: 'list' } | { kind: 'detail' } | { kind: 'edit'; original?: Document; text: string };

const NEW_DOCUMENT = '{\n  \n}';

export function DocumentScreen({ params }: { params: Params }) {
  const { app, nav, theme, settings, notify, notifyError } = useUi();
  const screenActive = useScreenActive();
  const layout = useLayout();
  const dialog = useDialog(layout.width);
  const { suspendTerminal } = useInkApp();
  const { db, collection } = params;
  const ns = `${db}.${collection}`;

  const [filterText, setFilterText] = useDraft(`docs:${ns}:filter`, params.filter ?? '{}');
  const [applied, setApplied] = useDraft(`docs:${ns}:applied`, {
    filter: params.filter ?? '{}',
    sort: '',
    projection: '',
  });
  const [pageSize, setPageSize] = useDraft(`docs:${ns}:pageSize`, settings.pageSize);
  const [page, setPage] = useState(0);
  const [editingFilter, setEditingFilter] = useState(Boolean(params.focusFilter));
  const [mode, setMode] = useState<Mode>(
    params.insert ? { kind: 'edit', text: NEW_DOCUMENT } : { kind: 'list' },
  );
  const [selected, setSelected] = useState(0);
  const [tick, setTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const anchors = useRef(new KeysetAnchors<unknown>());

  const parsed = (() => {
    try {
      return {
        filter: parseMongoObject(applied.filter, 'Filter'),
        sort: applied.sort.trim() ? (parseMongoObject(applied.sort, 'Sort') as Sort) : undefined,
        projection: applied.projection.trim()
          ? parseMongoObject(applied.projection, 'Projection')
          : undefined,
      };
    } catch (e) {
      return { error: e };
    }
  })();

  useEffect(() => {
    anchors.current.reset();
    setPage(0);
  }, [applied, pageSize]);

  const pageData = useAsync<DocumentPage>(() => {
    if ('error' in parsed) throw parsed.error;
    return app.db().documents.findPage({
      database: db,
      collection,
      filter: parsed.filter,
      sort: parsed.sort,
      projection: parsed.projection,
      page,
      pageSize,
      anchors: anchors.current,
      maxTimeMS: settings.queryTimeoutMs,
    });
  }, [db, collection, applied, page, pageSize, tick]);
  const total = useAsync<{ value?: number; estimate: boolean }>(async () => {
    if ('error' in parsed) return { estimate: true };
    if (Object.keys(parsed.filter).length === 0)
      return { value: await app.db().collections.estimatedCount(db, collection), estimate: true };
    const value = await app
      .db()
      .collections.exactCount(db, collection, parsed.filter, settings.exactCountTimeoutMs)
      .catch(() => undefined);
    return { value, estimate: false };
  }, [db, collection, applied, tick]);

  const docs = pageData.data?.documents ?? [];
  const current = docs[Math.min(selected, docs.length - 1)];
  const reload = () => setTick((t) => t + 1);
  const busy = saving || dialog.open;
  const listActive = screenActive && !busy && !editingFilter && mode.kind === 'list';

  const applyFilter = (text: string) => {
    try {
      parseMongoObject(text, 'Filter');
      setApplied((a) => ({ ...a, filter: text.trim() || '{}' }));
      setEditingFilter(false);
    } catch (e) {
      notifyError(e, 'Invalid filter');
    }
  };

  const copy = async (doc: Document) => {
    const text = EJSON.stringify(doc, undefined, 2, { relaxed: true });
    const res = await copyToClipboard(text);
    if (res.ok) {
      notify('success', 'Copied document as Extended JSON', `via ${res.method}`);
      return;
    }
    const file = path.join(
      settings.defaultExportDir || app.paths.exportsDir,
      `${collection}-${timestampForFilename()}.json`,
    );
    const save = await dialog.confirm({
      title: 'Clipboard unavailable',
      message: [res.reason ?? 'Clipboard is not available.', `Save the document to ${file} instead?`],
      confirmLabel: 'Save file',
    });
    if (!save) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    notify('success', 'Document saved', file);
  };

  const remove = async (doc: Document) => {
    const ok = await confirmOperation(
      { app, dialog, notify },
      Operations.deleteDocument,
      `Delete the document with _id ${formatScalar(doc._id)} from ${ns}?`,
      ['This cannot be undone.'],
      true,
    );
    if (!ok) return;
    try {
      const n = await app.db().documents.deleteById(db, collection, doc._id);
      notify(
        n ? 'success' : 'warning',
        n ? 'Document deleted' : 'Nothing deleted',
        n ? undefined : 'The document no longer exists.',
      );
      setMode({ kind: 'list' });
      reload();
    } catch (e) {
      notifyError(e, 'Delete failed');
    }
  };

  const duplicate = async (doc: Document) => {
    const ok = await confirmOperation(
      { app, dialog, notify },
      Operations.duplicateDocument,
      `Insert a copy of ${formatScalar(doc._id)} with a new _id?`,
      [],
      true,
    );
    if (!ok) return;
    try {
      const id = await app.db().documents.duplicate(db, collection, doc);
      notify('success', 'Document duplicated', `New _id: ${formatScalar(id)}`);
      reload();
    } catch (e) {
      notifyError(e, 'Duplicate failed');
    }
  };

  const startEdit = (doc?: Document) => {
    if (!app.permissions.check(doc ? Operations.updateDocument : Operations.insertDocument).allowed) {
      notify('warning', 'Read-only session', 'Press W to enable write access before editing.');
      return;
    }
    setMode({ kind: 'edit', original: doc, text: doc ? toShellString(doc) : NEW_DOCUMENT });
  };

  const editExternally = async (doc?: Document) => {
    if (!resolveEditor()) {
      notify(
        'warning',
        'No external editor',
        'Set $EDITOR (e.g. "code --wait", "nano", "vim") to use an external editor. Opening the built-in editor instead.',
      );
      startEdit(doc);
      return;
    }
    if (!app.permissions.check(doc ? Operations.updateDocument : Operations.insertDocument).allowed) {
      notify('warning', 'Read-only session', 'Press W to enable write access before editing.');
      return;
    }
    let result: string | undefined;
    try {
      await suspendTerminal(async () => {
        result = await editInExternalEditor(doc ? toShellString(doc) : NEW_DOCUMENT, '.js');
      });
    } catch (e) {
      notifyError(e, 'External editor failed');
      return;
    }
    if (result === undefined) {
      notify('info', 'Edit cancelled', 'The editor exited without saving.');
      return;
    }
    setMode({ kind: 'edit', original: doc, text: result });
  };

  const save = async (text: string, original?: Document) => {
    let doc: Document;
    try {
      doc = parseMongoObject(text, 'Document');
    } catch (e) {
      notifyError(e, 'Invalid document');
      return;
    }
    const op = original ? Operations.updateDocument : Operations.insertDocument;
    const ok = await confirmOperation(
      { app, dialog, notify },
      op,
      original
        ? `Replace document ${formatScalar(original._id)} in ${ns}?`
        : `Insert a new document into ${ns}?`,
    );
    if (!ok) return;
    setSaving(true);
    try {
      if (original) {
        const res = await app.db().documents.replaceById(db, collection, original._id, doc);
        notify(
          res.matched ? 'success' : 'warning',
          res.matched ? (res.modified ? 'Document updated' : 'No changes') : 'Document not found',
          res.matched ? undefined : 'It may have been deleted meanwhile.',
        );
      } else {
        const id = await app.db().documents.insertOne(db, collection, doc);
        notify('success', 'Document inserted', `_id: ${formatScalar(id)}`);
      }
      setMode({ kind: 'list' });
      reload();
    } catch (e) {
      notifyError(e, 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const docKeys = (input: string, doc: Document | undefined): boolean => {
    if (input === 'i') startEdit();
    else if (input === 'I') void editExternally();
    else if (!doc) return false;
    else if (input === 'e') startEdit(doc);
    else if (input === 'E') void editExternally(doc);
    else if (input === 'c') void copy(doc);
    else if (input === 'd') void remove(doc);
    else if (input === 'u') void duplicate(doc);
    else return false;
    return true;
  };

  useHints(
    mode.kind === 'edit'
      ? [
          { key: 'Ctrl+S', label: 'save' },
          { key: 'Esc', label: 'cancel' },
        ]
      : mode.kind === 'detail'
        ? [
            { key: '←→', label: 'collapse/expand' },
            { key: 'e', label: 'edit' },
            { key: 'c', label: 'copy' },
            { key: 'd', label: 'delete' },
            { key: 'u', label: 'duplicate' },
            { key: 'Esc', label: 'list' },
          ]
        : editingFilter
          ? [
              { key: 'Enter', label: 'apply filter' },
              { key: 'Esc', label: 'cancel' },
            ]
          : [
              { key: '←→', label: 'page' },
              { key: 'Enter', label: 'view' },
              { key: 'f', label: 'filter' },
              { key: 'i', label: 'insert' },
              { key: 'e/E', label: 'edit' },
              { key: 'd', label: 'delete' },
              { key: 'u', label: 'dup' },
              { key: 'c', label: 'copy' },
              { key: 's', label: 'sort' },
              { key: 'o', label: 'projection' },
              { key: 'z', label: `size ${pageSize}` },
              { key: 'x', label: 'export' },
              { key: 'r', label: 'refresh' },
            ],
    [mode.kind, editingFilter, pageSize],
  );

  // List mode keys
  useInput(
    (input, key) => {
      const info = pageData.data?.pageInfo;
      if (key.escape) return nav.back();
      if ((key.rightArrow || input === 'n') && info?.hasNext) {
        setPage((p) => p + 1);
        setSelected(0);
      } else if ((key.leftArrow || input === 'p') && page > 0) {
        setPage((p) => p - 1);
        setSelected(0);
      } else if (input === 'f' || input === '/') setEditingFilter(true);
      else if (input === 'r') reload();
      else if (input === 'x')
        nav.push('export', {
          db,
          collection,
          filter: applied.filter,
          sort: applied.sort,
          projection: applied.projection,
        });
      else if (input === 'z') {
        void dialog
          .prompt({
            title: 'Page size',
            label: `Documents per page (1-${MAX_PAGE_SIZE}):`,
            initial: String(pageSize),
            validate: (v) =>
              /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= MAX_PAGE_SIZE
                ? undefined
                : `Enter 1-${MAX_PAGE_SIZE}`,
          })
          .then((v) => v && setPageSize(Number(v)));
      } else if (input === 's') {
        void dialog
          .prompt({
            title: 'Sort',
            label: 'Sort:',
            initial: applied.sort,
            placeholder: '{ createdAt: -1 }',
            help: 'Sorting on _id (or no sort) uses fast keyset pagination; other sorts use skip/limit.',
          })
          .then((v) => {
            if (v === undefined) return;
            try {
              if (v.trim()) parseMongoObject(v, 'Sort');
              setApplied((a) => ({ ...a, sort: v }));
            } catch (e) {
              notifyError(e, 'Invalid sort');
            }
          });
      } else if (input === 'o') {
        void dialog
          .prompt({
            title: 'Projection',
            label: 'Projection:',
            initial: applied.projection,
            placeholder: '{ name: 1, email: 1 }',
          })
          .then((v) => {
            if (v === undefined) return;
            try {
              if (v.trim()) parseMongoObject(v, 'Projection');
              setApplied((a) => ({ ...a, projection: v }));
            } catch (e) {
              notifyError(e, 'Invalid projection');
            }
          });
      } else docKeys(input, current);
    },
    { isActive: listActive },
  );

  // Detail mode keys
  useInput(
    (input, key) => {
      if (key.escape) return setMode({ kind: 'list' });
      docKeys(input, current);
    },
    { isActive: screenActive && !busy && mode.kind === 'detail' },
  );

  if (dialog.open) return <Box justifyContent="center">{dialog.element}</Box>;
  if (saving) return <Loading label="Saving…" />;

  if (mode.kind === 'edit') {
    return (
      <Panel
        title={mode.original ? `Edit ${formatScalar(mode.original._id)}` : `Insert into ${ns}`}
        right="shell syntax: ObjectId(), ISODate(), NumberLong()…"
        focus
      >
        <TextArea
          value={mode.text}
          onChange={(text) => setMode({ ...mode, text })}
          focus={screenActive}
          height={layout.height - 4}
          width={layout.width - 4}
          initialCursor={mode.original ? undefined : { row: 1, col: 2 }}
          onSubmit={(text) => void save(text, mode.original)}
          onCancel={() => setMode({ kind: 'list' })}
        />
        <Muted>
          Ctrl+S save · Esc cancel · _id cannot be changed (use duplicate) · values are validated before
          saving
        </Muted>
      </Panel>
    );
  }

  const info = pageData.data?.pageInfo;
  const pageText = info
    ? describePage({ ...info, total: total.data?.value, totalIsEstimate: total.data?.estimate })
    : '';
  const header = (
    <Box flexDirection="column">
      <Box>
        <Text
          color={col(theme, editingFilter ? theme.colors.borderFocus : theme.colors.muted)}
          bold={editingFilter}
        >
          Filter:{' '}
        </Text>
        {editingFilter ? (
          <TextInput
            value={filterText}
            onChange={setFilterText}
            focus={screenActive && !busy}
            width={layout.width - 14}
            onSubmit={applyFilter}
            onCancel={() => {
              setFilterText(applied.filter);
              setEditingFilter(false);
            }}
            placeholder='{ status: "active" }'
          />
        ) : (
          <Text wrap="truncate-end">{applied.filter}</Text>
        )}
      </Box>
      {applied.sort || applied.projection ? (
        <Text color={col(theme, theme.colors.muted)} wrap="truncate-end">
          {applied.sort ? `Sort: ${applied.sort}  ` : ''}
          {applied.projection ? `Projection: ${applied.projection}` : ''}
        </Text>
      ) : null}
    </Box>
  );

  if (mode.kind === 'detail' && current) {
    return (
      <Panel title={`${ns} · ${formatScalar(current._id)}`} focus>
        <JsonView
          value={current}
          focus={screenActive && !busy}
          height={layout.height - 4}
          width={layout.width - 4}
          initialDepth={2}
        />
      </Panel>
    );
  }

  const listWidth = layout.wide ? Math.floor(layout.width * 0.45) : layout.width - 2;
  const extraHeaderRows = applied.sort || applied.projection ? 1 : 0;
  const listHeight = layout.height - 6 - extraHeaderRows;
  return (
    <Box flexDirection="column">
      {header}
      {'error' in parsed ? <ErrorBox error={parsed.error} title="Invalid query" /> : null}
      <Box flexDirection="row">
        <Panel
          title={`${ns}`}
          right={pageData.loading ? 'loading…' : pageText}
          focus={!editingFilter}
          width={listWidth}
        >
          {pageData.error ? (
            <ErrorBox error={pageData.error} />
          ) : pageData.loading && !pageData.data ? (
            <Loading label="Fetching documents…" />
          ) : (
            <SelectList
              items={docs.map((d, i) => ({
                key: `${page}-${i}`,
                label: documentSummary(d, listWidth - 6),
                value: i,
              }))}
              focus={listActive}
              height={listHeight}
              width={listWidth - 4}
              showDescription={false}
              initialIndex={Math.min(selected, Math.max(0, docs.length - 1))}
              emptyText={page > 0 ? 'No more documents' : 'No documents match the filter'}
              onHighlight={(item) => item && setSelected(item.value)}
              onSelect={(item) => {
                setSelected(item.value);
                setMode({ kind: 'detail' });
              }}
            />
          )}
        </Panel>
        {layout.wide && current ? (
          <Panel title="Preview" flexGrow={1}>
            <JsonView
              value={current}
              focus={false}
              height={listHeight}
              width={layout.width - listWidth - 6}
              initialDepth={1}
            />
          </Panel>
        ) : null}
      </Box>
      <Muted>
        {info
          ? `${info.strategy === 'keyset' ? 'Keyset' : 'Offset'} pagination · ${formatNumber(pageSize)} per page`
          : ''}
        {total.data && total.data.value === undefined && !total.loading
          ? ' · count timed out (filter not indexed?)'
          : ''}
        {total.data?.estimate ? ' · ~ estimated total' : ''}
        {current ? ` · ${truncate(formatScalar(current._id), 40)}` : ''}
      </Muted>
    </Box>
  );
}
