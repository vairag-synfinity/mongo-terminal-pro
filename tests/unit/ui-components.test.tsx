import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ObjectId } from '../../src/utils/bson.js';
import {
  documentSummary,
  flattenJson,
  formatScalar,
  toShellString,
} from '../../src/ui/components/bson-format.js';
import { DataTable, layoutColumns, type Column } from '../../src/ui/components/data-table.js';
import { ConfirmDialog } from '../../src/ui/components/dialog.js';
import { KeyHints } from '../../src/ui/components/feedback.js';
import { Form } from '../../src/ui/components/form.js';
import { JsonView } from '../../src/ui/components/json-view.js';
import { Panel } from '../../src/ui/components/panel.js';
import { SelectList } from '../../src/ui/components/select-list.js';
import { cleanDroppedPath, TextInput } from '../../src/ui/components/text-input.js';
import { TextArea } from '../../src/ui/components/text-area.js';
import { asciiFallback, col, createTheme } from '../../src/ui/themes/theme.js';
import { parseMongoObject } from '../../src/utils/validation.js';
import { TestProviders } from '../helpers/ui.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const KEYS = {
  up: '\u001B[A',
  down: '\u001B[B',
  right: '\u001B[C',
  left: '\u001B[D',
  enter: '\r',
  esc: '\u001B',
  tab: '\t',
  backspace: '\u007F',
  ctrlU: '\u0015',
};
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*m/;

function maxLineWidth(frame: string | undefined): number {
  return Math.max(...(frame ?? '').split('\n').map((l) => [...l].length));
}

describe('SelectList', () => {
  const items = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((l, i) => ({
    key: l,
    label: l,
    value: i,
  }));

  it('navigates with arrows and j/k and selects with Enter', async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = render(
      <TestProviders>
        <SelectList items={items} focus height={5} width={30} onSelect={(i) => onSelect(i.value)} />
      </TestProviders>,
    );
    await tick();
    expect(lastFrame()).toContain('❯ Alpha');
    stdin.write(KEYS.down);
    await tick();
    stdin.write('j');
    await tick();
    expect(lastFrame()).toContain('❯ Gamma');
    stdin.write('k');
    await tick();
    stdin.write(KEYS.enter);
    await tick();
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('filters with "/" search', async () => {
    const { stdin, lastFrame } = render(
      <TestProviders>
        <SelectList items={items} focus height={6} width={30} searchable onSelect={() => undefined} />
      </TestProviders>,
    );
    await tick();
    stdin.write('/');
    await tick();
    for (const c of 'ta') {
      stdin.write(c);
      await tick();
    }
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Beta');
    expect(frame).toContain('Delta');
    expect(frame).not.toContain('Alpha');
  });

  it('supports numeric shortcuts and skips disabled items', async () => {
    const onSelect = vi.fn();
    const numbered = items.map((i, n) => ({
      ...i,
      shortcut: String(n + 1),
      disabled: n === 1,
      disabledReason: 'connect first',
    }));
    const { stdin, lastFrame } = render(
      <TestProviders>
        <SelectList items={numbered} focus height={6} width={40} onSelect={(i) => onSelect(i.value)} />
      </TestProviders>,
    );
    await tick();
    expect(lastFrame()).toContain('connect first');
    stdin.write('3');
    await tick();
    expect(onSelect).toHaveBeenCalledWith(2);
    stdin.write('2');
    await tick();
    expect(onSelect).toHaveBeenCalledTimes(1); // disabled
  });

  it('scrolls long lists within the given height', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ key: String(i), label: `Item ${i}`, value: i }));
    const { stdin, lastFrame } = render(
      <TestProviders>
        <SelectList
          items={many}
          focus
          height={5}
          width={30}
          onSelect={() => undefined}
          showDescription={false}
        />
      </TestProviders>,
    );
    await tick();
    stdin.write('G');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Item 49');
    expect(frame).not.toContain('Item 0\n');
    expect(frame.split('\n').length).toBeLessThanOrEqual(5);
  });
});

describe('ASCII and no-colour modes', () => {
  it('renders ASCII borders and symbols when Unicode is unavailable', async () => {
    const { lastFrame } = render(
      <TestProviders unicode={false}>
        <Panel title="Main" focus>
          <SelectList
            items={[{ key: 'a', label: 'One', value: 1 }]}
            focus
            height={2}
            width={20}
            onSelect={() => undefined}
          />
        </Panel>
      </TestProviders>,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/^\+-+\+/);
    expect(frame).toContain('> One');
    expect(frame).not.toMatch(/[╭╮╰╯│─❯]/);
  });

  it('emits no colour codes in no-colour mode', async () => {
    const theme = createTheme('dark', true);
    expect(col(theme, theme.colors.primary)).toBeUndefined();
    const { lastFrame } = render(
      <TestProviders noColor>
        <KeyHints hints={[{ key: 'Enter', label: 'open' }]} width={40} />
      </TestProviders>,
    );
    await tick();
    expect(ANSI.test(lastFrame() ?? '')).toBe(false);
  });

  it('replaces Unicode glyphs in hints with ASCII', () => {
    expect(asciiFallback('↑↓ navigate › next…', false)).toBe('Up/Dn navigate > next...');
    expect(asciiFallback('↑↓', true)).toBe('↑↓');
  });
});

describe('DataTable', () => {
  interface Row {
    name: string;
    size: string;
    count: string;
    extra: string;
  }
  const columns: Column<Row>[] = [
    { key: 'name', title: 'Name', render: (r) => r.name, minWidth: 10 },
    { key: 'size', title: 'Size', width: 10, render: (r) => r.size, priority: 2 },
    { key: 'count', title: 'Count', width: 10, render: (r) => r.count, priority: 3 },
    { key: 'extra', title: 'Extra', width: 20, render: (r) => r.extra, priority: 1 },
  ];
  const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({
    name: `collection_${i}_with_a_long_name`,
    size: '1.0 MB',
    count: String(i),
    extra: 'extra',
  }));

  it('drops low-priority columns on narrow terminals', () => {
    expect(layoutColumns(columns, 120).map((c) => c.column.key)).toEqual(['name', 'size', 'count', 'extra']);
    expect(layoutColumns(columns, 40).map((c) => c.column.key)).toEqual(['name', 'size', 'count']);
    expect(layoutColumns(columns, 25).map((c) => c.column.key)).toEqual(['name', 'count']);
    expect(layoutColumns(columns, 15).map((c) => c.column.key)).toEqual(['name']);
  });

  for (const width of [40, 60, 80, 120, 200]) {
    it(`never overflows ${width} columns`, async () => {
      const { lastFrame } = render(
        <TestProviders width={width}>
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.name} focus height={8} width={width} />
        </TestProviders>,
      );
      await tick();
      expect(maxLineWidth(lastFrame())).toBeLessThanOrEqual(width);
    });
  }

  it('moves the selection and reports it', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <TestProviders>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.name}
          focus
          height={8}
          width={80}
          onSelect={(r) => onSelect(r.count)}
        />
      </TestProviders>,
    );
    await tick();
    stdin.write(KEYS.down);
    await tick();
    stdin.write(KEYS.down);
    await tick();
    stdin.write(KEYS.enter);
    await tick();
    expect(onSelect).toHaveBeenCalledWith('2');
  });
});

describe('JSON tree view and BSON formatting', () => {
  const doc = {
    _id: new ObjectId('65a000000000000000000001'),
    name: 'Ada',
    tags: ['a', 'b'],
    address: { city: 'Pune' },
    at: new Date('2024-01-01T00:00:00Z'),
  };

  it('formats BSON values in shell notation', () => {
    expect(formatScalar(doc._id)).toBe("ObjectId('65a000000000000000000001')");
    expect(formatScalar(doc.at)).toBe("ISODate('2024-01-01T00:00:00.000Z')");
    expect(documentSummary(doc, 200)).toMatch(/^ObjectId\('65a0.*name: "Ada"/);
  });

  it('serialises documents for editing losslessly', () => {
    const text = toShellString(doc);
    const back = parseMongoObject(text);
    expect((back._id as ObjectId).toHexString()).toBe('65a000000000000000000001');
    expect(back.at).toEqual(doc.at);
    expect(back.tags).toEqual(['a', 'b']);
  });

  it('keeps exact numeric types through the editor round trip', async () => {
    const { Double, Int32, Long, bsonType } = await import('../../src/utils/bson.js');
    const original = {
      i: new Int32(5),
      d: new Double(7),
      f: new Double(1.5),
      l: Long.fromNumber(5),
      n: [new Int32(1)],
    };
    const text = toShellString(original);
    expect(text).toContain('NumberInt(5)');
    expect(text).toContain('Double(7)');
    const back = parseMongoObject(text);
    expect([
      bsonType(back.i),
      bsonType(back.d),
      bsonType(back.l),
      bsonType((back.n as unknown[])[0]),
    ]).toEqual(['Int32', 'Double', 'Long', 'Int32']);
    expect(typeof back.f === 'number' || bsonType(back.f) === 'Double').toBe(true);
    expect(formatScalar(new Int32(5))).toBe('5');
    expect(formatScalar(new Double(7))).toBe('7.0');
  });

  it('flattens with expand/collapse state', () => {
    expect(flattenJson(doc, new Set()).length).toBe(1);
    const lines = flattenJson(doc, new Set(['$']));
    expect(lines.map((l) => l.key).filter(Boolean)).toEqual(['_id', 'name', 'tags', 'address', 'at']);
    expect(lines.find((l) => l.key === 'tags')?.text).toMatch(/2 items/);
  });

  it('expands and collapses with the keyboard', async () => {
    const { stdin, lastFrame } = render(
      <TestProviders>
        <JsonView value={doc} focus height={20} width={60} initialDepth={0} />
      </TestProviders>,
    );
    await tick();
    expect(lastFrame()).toContain('address: { … }');
    for (let i = 0; i < 4; i++) {
      stdin.write(KEYS.down);
      await tick();
    }
    stdin.write(KEYS.right);
    await tick();
    expect(lastFrame()).toContain('city: "Pune"');
    stdin.write(KEYS.left);
    await tick();
    expect(lastFrame()).not.toContain('city: "Pune"');
    stdin.write('E');
    await tick();
    expect(lastFrame()).toContain('"a"');
  });
});

describe('text editing', () => {
  function InputHarness({ onSubmit }: { onSubmit(v: string): void }) {
    const [v, setV] = useState('');
    return <TextInput value={v} onChange={setV} focus width={30} onSubmit={onSubmit} />;
  }

  it('edits single-line input with cursor movement and kill keys', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <TestProviders>
        <InputHarness onSubmit={onSubmit} />
      </TestProviders>,
    );
    await tick();
    for (const c of 'helo') {
      stdin.write(c);
      await tick(10);
    }
    stdin.write(KEYS.left);
    await tick();
    stdin.write('l');
    await tick();
    stdin.write(KEYS.enter);
    await tick();
    expect(onSubmit).toHaveBeenLastCalledWith('hello');
    stdin.write(KEYS.backspace);
    await tick();
    stdin.write(KEYS.enter);
    await tick();
    expect(onSubmit).toHaveBeenLastCalledWith('helo'); // cursor sits after the inserted 'l'
    stdin.write(KEYS.ctrlU);
    await tick();
    stdin.write(KEYS.enter);
    await tick();
    expect(onSubmit).toHaveBeenLastCalledWith('o'); // Ctrl+U deletes to the start of the line (readline semantics)
  });

  it('masks passwords', async () => {
    const { lastFrame } = render(
      <TestProviders>
        <TextInput value="secret" onChange={() => undefined} focus={false} mask width={20} />
      </TestProviders>,
    );
    await tick();
    expect(lastFrame()).not.toContain('secret');
    expect(lastFrame()).toContain('••••••');
  });

  it('cleans dragged-and-dropped paths', () => {
    expect(cleanDroppedPath("'/tmp/my file.json'")).toBe('/tmp/my file.json');
    expect(cleanDroppedPath('file:///tmp/a%20b.json')).toBe('/tmp/a b.json');
    if (process.platform !== 'win32')
      expect(cleanDroppedPath('/tmp/my\\ file.json')).toBe('/tmp/my file.json');
  });

  function AreaHarness({ onSubmit }: { onSubmit(v: string): void }) {
    const [v, setV] = useState('{\n  \n}');
    return (
      <TextArea
        value={v}
        onChange={setV}
        focus
        height={6}
        width={40}
        onSubmit={onSubmit}
        initialCursor={{ row: 1, col: 2 }}
      />
    );
  }

  it('edits multi-line text and auto-indents', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <TestProviders>
        <AreaHarness onSubmit={onSubmit} />
      </TestProviders>,
    );
    await tick();
    for (const c of 'a: {') {
      stdin.write(c);
      await tick(10);
    }
    stdin.write(KEYS.enter);
    await tick();
    for (const c of 'b: 1') {
      stdin.write(c);
      await tick(10);
    }
    stdin.write('\u0013'); // Ctrl+S
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('{\n  a: {\n    b: 1\n}');
    expect(lastFrame()).toContain('3     b: 1');
  });
});

describe('dialogs and forms', () => {
  it('confirms with y and cancels with Esc', async () => {
    const onResult = vi.fn();
    const { stdin, lastFrame } = render(
      <TestProviders>
        <ConfirmDialog
          options={{ title: 'Drop?', message: 'Really', danger: true }}
          onResult={onResult}
          width={50}
        />
      </TestProviders>,
    );
    await tick();
    expect(lastFrame()).toContain('Drop?');
    stdin.write('y');
    await tick();
    expect(onResult).toHaveBeenCalledWith(true);
  });

  it('requires typing the exact name for type-to-confirm', async () => {
    const onResult = vi.fn();
    const { stdin } = render(
      <TestProviders>
        <ConfirmDialog
          options={{ title: 'Prod', message: 'x', typeToConfirm: 'Prod DB' }}
          onResult={onResult}
          width={60}
        />
      </TestProviders>,
    );
    await tick();
    stdin.write('y'); // must NOT confirm
    await tick();
    expect(onResult).not.toHaveBeenCalled();
    stdin.write(KEYS.enter);
    await tick();
    expect(onResult).toHaveBeenLastCalledWith(false);
  });

  it('navigates form fields and toggles values', async () => {
    const onPress = vi.fn();
    function FormHarness() {
      const [values, setValues] = useState<Record<string, unknown>>({
        name: '',
        production: false,
        mode: 'a',
      });
      return (
        <>
          <Form
            fields={[
              { key: 'name', label: 'Name', kind: 'text' },
              { key: 'production', label: 'Production', kind: 'toggle' },
              {
                key: 'mode',
                label: 'Mode',
                kind: 'select',
                options: [
                  { label: 'A', value: 'a' },
                  { label: 'B', value: 'b' },
                ],
              },
            ]}
            values={values}
            onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))}
            focus
            width={60}
            actions={[{ key: 'save', label: 'Save', tone: 'primary', onPress: () => onPress(values) }]}
          />
          <Text>{JSON.stringify(values)}</Text>
        </>
      );
    }
    const { stdin, lastFrame } = render(
      <TestProviders>
        <FormHarness />
      </TestProviders>,
    );
    await tick();
    for (const c of 'db1') {
      stdin.write(c);
      await tick(10);
    }
    stdin.write(KEYS.tab);
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write(KEYS.tab);
    await tick();
    stdin.write(KEYS.right);
    await tick();
    expect(lastFrame()).toContain('{"name":"db1","production":true,"mode":"b"}');
    stdin.write('\u0013');
    await tick();
    expect(onPress).toHaveBeenCalledWith({ name: 'db1', production: true, mode: 'b' });
  });
});
