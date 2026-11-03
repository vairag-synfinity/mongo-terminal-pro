import { Box, Text } from 'ink';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React, { useEffect, useState } from 'react';
import { formatBytes, truncate } from '../../utils/formatting.js';
import { useUi } from '../context.js';
import { col } from '../themes/theme.js';
import { SelectList, type SelectItem } from './select-list.js';

interface Entry {
  name: string;
  full: string;
  dir: boolean;
  size?: number;
}

export interface FileBrowserProps {
  initialDir?: string;
  /** Lower-case extensions to show, e.g. ['.json', '.csv']; directories always show. */
  extensions?: string[];
  /** 'file' picks a file; 'directory' picks the current directory with "." */
  mode: 'file' | 'directory';
  focus: boolean;
  height: number;
  width: number;
  onPick(fullPath: string): void;
  onCancel(): void;
}

async function listWindowsDrives(): Promise<Entry[]> {
  const drives: Entry[] = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    try {
      await fs.access(root);
      drives.push({ name: root, full: root, dir: true });
    } catch {
      // not present
    }
  }
  return drives;
}

/**
 * Terminal file picker: ↑↓ move, Enter open/select, ← or Backspace parent, ~ home, . toggle hidden,
 * / filter. Works over SSH and in every terminal (no OS dialog needed).
 */
export function FileBrowser({
  initialDir,
  extensions,
  mode,
  focus,
  height,
  width,
  onPick,
  onCancel,
}: FileBrowserProps) {
  const { theme } = useUi();
  const [dir, setDir] = useState(() => path.resolve(initialDir ?? process.cwd()));
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [showHidden, setShowHidden] = useState(false);
  const [atDrives, setAtDrives] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (atDrives) {
          const drives = await listWindowsDrives();
          if (alive) setEntries(drives);
          return;
        }
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        const list: Entry[] = [];
        for (const d of dirents.slice(0, 5000)) {
          if (!showHidden && d.name.startsWith('.')) continue;
          const full = path.join(dir, d.name);
          let isDir = d.isDirectory();
          if (d.isSymbolicLink())
            isDir = await fs
              .stat(full)
              .then((s) => s.isDirectory())
              .catch(() => false);
          if (!isDir && extensions?.length && !extensions.some((e) => d.name.toLowerCase().endsWith(e)))
            continue;
          if (!isDir && mode === 'directory') continue;
          list.push({ name: d.name, full, dir: isDir });
        }
        list.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
        await Promise.all(
          list
            .filter((e) => !e.dir)
            .slice(0, 300)
            .map(async (e) => {
              e.size = await fs
                .stat(e.full)
                .then((s) => s.size)
                .catch(() => undefined);
            }),
        );
        if (alive) {
          setEntries(list);
          setError(undefined);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [dir, showHidden, extensions, mode, atDrives]);

  const parent = () => {
    const up = path.dirname(dir);
    if (up === dir) {
      if (process.platform === 'win32') setAtDrives(true);
      return;
    }
    setDir(up);
  };

  const items: SelectItem<Entry | null>[] = [
    ...(mode === 'directory' && !atDrives
      ? [{ key: '__select__', label: '[ Use this directory ]', value: null, color: theme.colors.success }]
      : []),
    ...(!atDrives
      ? [
          {
            key: '__up__',
            label: '..',
            value: { name: '..', full: path.dirname(dir), dir: true } as Entry,
            hint: 'parent',
          },
        ]
      : []),
    ...entries.map((e) => ({
      key: e.full,
      label: e.dir ? `${e.name}${path.sep}` : e.name,
      value: e,
      hint: e.dir ? 'dir' : formatBytes(e.size),
      color: e.dir ? theme.colors.info : undefined,
    })),
  ];

  return (
    <Box flexDirection="column">
      <Text color={col(theme, theme.colors.muted)}>{truncate(atDrives ? 'Drives' : dir, width)}</Text>
      {error ? <Text color={col(theme, theme.colors.error)}>{truncate(error, width)}</Text> : null}
      <SelectList
        items={items}
        focus={focus}
        height={Math.max(3, height - 3)}
        width={width}
        searchable
        showDescription={false}
        onSelect={(item) => {
          if (item.value === null) return onPick(dir);
          if (item.key === '__up__') return parent();
          if (item.value.dir) {
            setAtDrives(false);
            setDir(item.value.full);
          } else onPick(item.value.full);
        }}
        onKey={(input) => {
          if (input === '~') {
            setAtDrives(false);
            setDir(os.homedir());
          } else if (input === '.') setShowHidden((h) => !h);
          else if (input === 'q') onCancel();
          else if (input === '-' || input === 'h') parent();
        }}
      />
      <Text color={col(theme, theme.colors.muted)}>
        Enter open/select · - parent · ~ home · . hidden · / filter · q cancel
      </Text>
    </Box>
  );
}
