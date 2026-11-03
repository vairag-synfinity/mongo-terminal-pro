import { Box, Text, useInput } from 'ink';
import path from 'node:path';
import React, { useState } from 'react';
import { createConfigBackup, restoreConfigBackup } from '../../config/configuration.js';
import {
  DEFAULT_SETTINGS,
  SETTING_DESCRIPTORS,
  SettingsSchema,
  type SettingDescriptor,
  type Settings,
} from '../../config/defaults.js';
import { timestampForFilename, truncate } from '../../utils/formatting.js';
import { useDialog } from '../components/dialog.js';
import { Muted } from '../components/feedback.js';
import { Panel } from '../components/panel.js';
import { SelectList, type SelectItem } from '../components/select-list.js';
import { useScreenActive, useUi } from '../context.js';
import { useAsync } from '../hooks/use-async.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';

type Entry =
  | { kind: 'setting'; descriptor: SettingDescriptor }
  | { kind: 'action'; id: 'export' | 'import' | 'reset' | 'history' | 'paths' };

export function SettingsScreen() {
  const { app, nav, theme, settings, updateSettings, notify, notifyError } = useUi();
  const screenActive = useScreenActive();
  const layout = useLayout();
  const dialog = useDialog(layout.width);
  const [showPaths, setShowPaths] = useState(false);
  const backend = useAsync(() => app.credentials.backend(), []);
  const active = screenActive && !dialog.open;

  useHints([
    { key: 'Enter', label: 'change' },
    { key: '←→', label: 'cycle' },
    { key: '/', label: 'filter' },
    { key: 'Esc', label: 'back' },
  ]);

  const setValue = async (d: SettingDescriptor, raw: unknown) => {
    const candidate = { ...settings, [d.key]: raw } as Settings;
    const parsed = SettingsSchema.safeParse(candidate);
    if (!parsed.success) {
      notify('error', `Invalid value for ${d.label}`, parsed.error.issues[0]?.message);
      return;
    }
    await updateSettings({ [d.key]: parsed.data[d.key] } as Partial<Settings>);
    if (d.key === 'credentialStorage')
      notify(
        'info',
        'Credential storage changed',
        'Takes effect after restarting the app. Existing stored passwords are not migrated.',
      );
    if (d.key === 'mouse')
      notify('info', 'Mouse setting saved', 'Takes effect on next start (or use --mouse).');
  };

  const cycle = (d: SettingDescriptor, delta: number) => {
    const current = settings[d.key];
    if (d.kind === 'boolean') return void setValue(d, !current);
    if (d.kind === 'enum' && d.options) {
      const i = Math.max(0, d.options.indexOf(String(current)));
      return void setValue(d, d.options[(i + delta + d.options.length) % d.options.length]);
    }
  };

  const edit = async (d: SettingDescriptor) => {
    if (d.kind === 'boolean' || d.kind === 'enum') return cycle(d, 1);
    const value = await dialog.prompt({
      title: d.label,
      label: `${d.label}:`,
      initial: settings[d.key] === undefined ? '' : String(settings[d.key]),
      help: `${d.description} (default: ${String(DEFAULT_SETTINGS[d.key] ?? 'none')})`,
    });
    if (value === undefined) return;
    if (d.kind === 'number') {
      if (!/^\d+$/.test(value.trim())) return notify('error', 'Please enter a whole number');
      return setValue(d, Number(value));
    }
    return setValue(d, value.trim() === '' ? undefined : value.trim());
  };

  const runAction = async (id: Extract<Entry, { kind: 'action' }>['id']) => {
    try {
      if (id === 'export') {
        const file = await dialog.prompt({
          title: 'Back up configuration',
          label: 'File:',
          initial: path.join(app.paths.dataDir, `mtp-config-${timestampForFilename()}.json`),
          help: 'Includes settings, connection profiles (without passwords) and saved queries.',
        });
        if (!file) return;
        await createConfigBackup(app.paths, path.resolve(file));
        notify('success', 'Configuration backed up', path.resolve(file));
      } else if (id === 'import') {
        const file = await dialog.prompt({
          title: 'Restore configuration',
          label: 'File:',
          help: 'Existing connections are kept (merge). Passwords must be re-entered.',
        });
        if (!file) return;
        const res = await restoreConfigBackup(app.paths, path.resolve(file), { merge: true });
        app.config.store.invalidate();
        app.connections.store.invalidate();
        app.history.store.invalidate();
        await updateSettings({});
        notify(
          'success',
          'Configuration restored',
          `${res.connections} connection(s), ${res.savedQueries} saved quer(ies)`,
        );
      } else if (id === 'reset') {
        const ok = await dialog.confirm({
          title: 'Reset settings',
          message: 'Restore all settings to their defaults? Connections and history are not affected.',
        });
        if (!ok) return;
        await app.config.reset();
        await updateSettings({});
        notify('success', 'Settings reset to defaults');
      } else if (id === 'history') {
        const ok = await dialog.confirm({
          title: 'Clear query history',
          message: 'Remove all query history entries? Saved queries are kept.',
        });
        if (!ok) return;
        await app.history.clearHistory();
        notify('success', 'Query history cleared');
      } else if (id === 'paths') setShowPaths((v) => !v);
    } catch (e) {
      notifyError(e);
    }
  };

  const [highlighted, setHighlighted] = useState<Entry | undefined>();
  useInput(
    (_input, key) => {
      if (key.escape) nav.back();
      else if ((key.leftArrow || key.rightArrow) && highlighted?.kind === 'setting')
        cycle(highlighted.descriptor, key.leftArrow ? -1 : 1);
    },
    { isActive: active },
  );

  if (dialog.open) return <Box justifyContent="center">{dialog.element}</Box>;

  const valueText = (d: SettingDescriptor) => {
    const v = settings[d.key];
    if (v === undefined || v === '') return '(default)';
    if (typeof v === 'boolean') return v ? 'on' : 'off';
    return String(v);
  };
  const items: SelectItem<Entry>[] = [
    ...SETTING_DESCRIPTORS.map((d, i) => ({
      key: d.key,
      label: d.label,
      value: { kind: 'setting', descriptor: d } as Entry,
      hint: truncate(valueText(d), 30),
      description: d.description,
      section: i === 0 ? 'Preferences' : undefined,
    })),
    {
      key: 'a-export',
      label: 'Back up configuration…',
      value: { kind: 'action', id: 'export' },
      section: 'Maintenance',
      description: 'Settings, connections (no secrets), saved queries',
    },
    {
      key: 'a-import',
      label: 'Restore configuration…',
      value: { kind: 'action', id: 'import' },
      description: 'Merge a configuration backup',
    },
    { key: 'a-history', label: 'Clear query history', value: { kind: 'action', id: 'history' } },
    { key: 'a-reset', label: 'Reset settings to defaults', value: { kind: 'action', id: 'reset' } },
    {
      key: 'a-paths',
      label: showPaths ? 'Hide file locations' : 'Show file locations',
      value: { kind: 'action', id: 'paths' },
    },
  ];
  return (
    <Box flexDirection="column">
      <Panel title="Settings" right={backend.data ? truncate(backend.data.description, 50) : undefined} focus>
        <SelectList
          items={items}
          focus={active}
          height={layout.height - (showPaths ? 10 : 4)}
          width={layout.width - 4}
          searchable
          onSelect={(item) =>
            item.value.kind === 'setting' ? void edit(item.value.descriptor) : void runAction(item.value.id)
          }
          onHighlight={(item) => setHighlighted(item?.value)}
        />
      </Panel>
      {showPaths ? (
        <Box flexDirection="column">
          <Text color={col(theme, theme.colors.muted)}>Config: {app.paths.configDir}</Text>
          <Text color={col(theme, theme.colors.muted)}>Data: {app.paths.dataDir}</Text>
          <Text color={col(theme, theme.colors.muted)}>Logs: {app.paths.logFile}</Text>
          <Text color={col(theme, theme.colors.muted)}>
            Backups: {settings.defaultBackupDir || app.paths.backupsDir}
          </Text>
          <Text color={col(theme, theme.colors.muted)}>
            Exports: {settings.defaultExportDir || app.paths.exportsDir}
          </Text>
        </Box>
      ) : null}
      <Muted>Enter edits a value; ← → cycle options and toggles. Values are validated before saving.</Muted>
    </Box>
  );
}
