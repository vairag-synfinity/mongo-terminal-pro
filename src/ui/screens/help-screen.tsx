import { useInput } from 'ink';
import React from 'react';
import { Panel } from '../components/panel.js';
import { ScrollText, type ScrollLine } from '../components/scroll-text.js';
import { useScreenActive, useUi } from '../context.js';
import { useHints, useLayout } from '../layouts/layout.js';

export function HelpScreen() {
  const { nav, theme, caps, symbols, settings } = useUi();
  const active = useScreenActive();
  const layout = useLayout();
  useHints([
    { key: '↑↓', label: 'scroll' },
    { key: 'Esc', label: 'back' },
  ]);
  useInput(
    (input, key) => {
      if (key.escape || input === 'q') nav.back();
    },
    { isActive: active },
  );

  const h = (text: string): ScrollLine => ({ text, bold: true, color: theme.colors.title });
  const lines: (string | ScrollLine)[] = [
    h('GLOBAL'),
    '  ?            this help                    W        toggle write access (read-only by default)',
    '  Esc          back / cancel                Ctrl+C   quit (cleanly disconnects)',
    '  Q            quit                         Ctrl+X   dismiss notifications',
    '',
    h('WORKSPACE (after connecting)'),
    '  Left: database tree      ↑↓ move · → expand · ← collapse · Enter open · / filter · r refresh',
    '  Right: tabs              Documents · Aggregations · Query · Indexes · Schema & Stats · Import · Export',
    '  Tab                      sidebar → pane          Esc   pane → sidebar → connections',
    '  [ ]                      previous / next tab     m menu · b backup · S statistics · , settings',
    '',
    h('WHOLE DATABASES (tree shortcuts on a database)'),
    '  C   copy / migrate the database (all or chosen collections) to another database or connection',
    '  x   export the database (one file per collection)      X   export ALL databases (folder per db)',
    '  I   import a folder into the database (or every database from an export-all folder)',
    '',
    h('FORMS: DATABASE AND COLLECTION FIELDS'),
    '  Type a name, or press ↓ to pick from the existing ones (Enter to choose). New names are marked "+ new".',
    '',
    h('LISTS'),
    '  ↑ ↓ / j k    move                         PgUp PgDn  page',
    '  Home End / g G  first / last              /        filter',
    '  Enter        select                       1-13     menu shortcuts (main menu)',
    '',
    h('DOCUMENTS'),
    '  ← → / p n    previous / next page         f        edit filter (Enter applies)',
    '  Enter        view document tree           i        insert document',
    '  e            edit (in-app editor)         E        edit in $EDITOR',
    '  u            duplicate                    d        delete (confirmation)',
    '  c            copy as Extended JSON        z        page size',
    '  s / o        sort / projection            x        export these results',
    '  r            refresh',
    '',
    h('JSON TREE'),
    '  → / Enter    expand                       ←        collapse',
    '  E            expand all                   C        collapse all',
    '',
    h('EDITORS AND FORMS'),
    '  Tab / Shift+Tab  next / previous field    Ctrl+S   save / submit',
    '  Ctrl+R       run (query & aggregation)    Esc      leave editor',
    '  Ctrl+U / Ctrl+K  delete to start / end    Ctrl+W   delete word',
    '  Paste is supported (bracketed paste). Drop a file on the terminal to paste its path.',
    '',
    h('QUERY SYNTAX'),
    '  Strict JSON, Extended JSON and shell syntax are accepted:',
    '  { status: "active", age: { $gte: 18 }, _id: ObjectId("..."), at: ISODate("2024-01-01") }',
    '  NumberLong(), NumberInt(), NumberDecimal(), UUID(), BinData(), Timestamp(), /regex/i',
    '',
    h('SAFETY'),
    '  Sessions start read-only. Press W to enable writes; production connections require typing the name.',
    '  Deletes, drops, updateMany/deleteMany, upsert imports and restores always ask for confirmation.',
    '  Queries and pipelines run with time limits and result caps (Settings).',
    '',
    h('TERMINAL'),
    `  Colours: ${theme.noColor ? 'off' : ['none', '16', '256', 'truecolor'][caps.colorLevel]}   Symbols: ${symbols.unicode ? 'Unicode' : 'ASCII'}   Size: ${caps.columns}x${caps.rows}   Mouse wheel: ${settings.mouse ? 'on' : 'off (Settings)'}`,
    '  Use --ascii or --no-color if symbols or colours look wrong. NO_COLOR is respected.',
    '',
    h('ABOUT'),
    '  Mongo Terminal Pro — made by Vairag Kakadiya. MIT licensed.',
  ];
  return (
    <Panel title="Keyboard shortcuts & help" focus>
      <ScrollText lines={lines} height={layout.height - 3} width={layout.width - 4} focus={active} />
    </Panel>
  );
}
