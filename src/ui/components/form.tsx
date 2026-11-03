import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';
import { truncate } from '../../utils/formatting.js';
import { useUi } from '../context.js';
import { col } from '../themes/theme.js';
import { TextArea } from './text-area.js';
import { TextInput } from './text-input.js';

export type FieldKind = 'text' | 'password' | 'number' | 'select' | 'toggle' | 'textarea';

export interface FieldOption {
  label: string;
  value: string;
}

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  options?: FieldOption[];
  placeholder?: string;
  help?: string;
  hidden?: boolean;
  disabled?: boolean;
  /** Rows for textarea fields. */
  rows?: number;
}

export interface FormAction {
  key: string;
  label: string;
  tone?: 'primary' | 'danger' | 'default';
  disabled?: boolean;
  onPress(): void;
}

export interface FormProps {
  fields: FieldDef[];
  values: Record<string, unknown>;
  onChange(key: string, value: unknown): void;
  actions: FormAction[];
  focus: boolean;
  width: number;
  errors?: Record<string, string | undefined>;
  labelWidth?: number;
  /** Shown under the actions (e.g. test results). */
  footer?: React.ReactNode;
  /** Max visible field rows before the form scrolls. */
  height?: number;
  onCancel?(): void;
}

/**
 * Keyboard form: Tab/↓ next field, Shift+Tab/↑ previous, Enter next (or press button),
 * Space/←→ toggle and cycle options, Ctrl+S runs the first primary action, Esc cancels.
 */
export function Form({
  fields,
  values,
  onChange,
  actions,
  focus,
  width,
  errors = {},
  labelWidth = 22,
  footer,
  height,
  onCancel,
}: FormProps) {
  const { theme, symbols } = useUi();
  const visibleFields = fields.filter((f) => !f.hidden);
  const total = visibleFields.length + 1; // +1 = actions row
  const [index, setIndex] = useState(0);
  const [actionIndex, setActionIndex] = useState(0);

  useEffect(() => {
    if (index >= total) setIndex(total - 1);
  }, [index, total]);

  const field = visibleFields[index];
  const onActions = index === visibleFields.length;
  const next = () => setIndex((i) => Math.min(total - 1, i + 1));
  const prev = () => setIndex((i) => Math.max(0, i - 1));
  const primary = actions.find((a) => a.tone === 'primary' && !a.disabled);

  useInput(
    (input, key) => {
      if (key.ctrl && input === 's') {
        primary?.onPress();
        return;
      }
      if (key.escape) {
        if (field?.kind === 'textarea') {
          next();
          return;
        }
        onCancel?.();
        return;
      }
      if (key.tab) {
        if (key.shift) prev();
        else next();
        return;
      }
      if (field?.kind === 'textarea') return; // the editor owns arrows/enter
      if (key.upArrow) return prev();
      if (key.downArrow) return next();
      if (onActions) {
        const enabled = actions.map((a, i) => (a.disabled ? -1 : i)).filter((i) => i >= 0);
        if (key.leftArrow || key.rightArrow) {
          const pos = enabled.indexOf(actionIndex);
          const delta = key.leftArrow ? -1 : 1;
          setActionIndex(enabled[(pos + delta + enabled.length) % enabled.length] ?? 0);
        } else if (key.return) {
          const a = actions[actionIndex];
          if (a && !a.disabled) a.onPress();
        }
        return;
      }
      if (!field || field.disabled) {
        if (key.return) next();
        return;
      }
      if (field.kind === 'toggle' && (input === ' ' || key.return || key.leftArrow || key.rightArrow)) {
        onChange(field.key, !values[field.key]);
        return;
      }
      if (
        field.kind === 'select' &&
        field.options?.length &&
        (input === ' ' || key.leftArrow || key.rightArrow || key.return)
      ) {
        if (key.return) return next();
        const opts = field.options;
        const pos = Math.max(
          0,
          opts.findIndex((o) => o.value === values[field.key]),
        );
        const delta = key.leftArrow ? -1 : 1;
        onChange(field.key, opts[(pos + delta + opts.length) % opts.length]?.value);
      }
    },
    { isActive: focus },
  );

  const inputWidth = Math.max(10, width - labelWidth - 4);
  const maxRows = height ?? 1000;
  // Scroll so the focused field is visible (textareas count as multiple rows).
  const rowsOf = (f: FieldDef) => (f.kind === 'textarea' ? (f.rows ?? 4) : 1) + (errors[f.key] ? 1 : 0);
  let start = 0;
  let used = 0;
  for (let i = Math.min(index, visibleFields.length - 1); i >= 0; i--) {
    used += rowsOf(visibleFields[i] as FieldDef);
    if (used > maxRows - 3) {
      start = i + 1;
      break;
    }
  }
  let budget = maxRows - 2;
  const shown: FieldDef[] = [];
  for (const f of visibleFields.slice(start)) {
    const r = rowsOf(f);
    if (budget - r < 0 && shown.length > 0) break;
    shown.push(f);
    budget -= r;
  }

  return (
    <Box flexDirection="column" width={width}>
      {start > 0 ? <Text color={col(theme, theme.colors.muted)}>{symbols.arrowUp} more fields</Text> : null}
      {shown.map((f) => {
        const i = visibleFields.indexOf(f);
        const active = focus && i === index;
        const value = values[f.key];
        const labelColor = active
          ? theme.colors.borderFocus
          : f.disabled
            ? theme.colors.muted
            : theme.colors.text;
        let control: React.ReactNode;
        switch (f.kind) {
          case 'toggle':
            control = (
              <Text color={col(theme, value ? theme.colors.success : theme.colors.muted)}>
                {value ? symbols.checkboxOn : symbols.checkboxOff} {value ? 'Yes' : 'No'}
              </Text>
            );
            break;
          case 'select': {
            const opt = f.options?.find((o) => o.value === value);
            control = (
              <Text>
                <Text color={col(theme, theme.colors.muted)}>{active ? `${symbols.arrowLeft} ` : ''}</Text>
                <Text bold={active}>{opt?.label ?? String(value ?? '')}</Text>
                <Text color={col(theme, theme.colors.muted)}>{active ? ` ${symbols.arrowRight}` : ''}</Text>
              </Text>
            );
            break;
          }
          case 'textarea':
            control = (
              <Box
                borderStyle={symbols.borderStyle}
                borderColor={col(theme, active ? theme.colors.borderFocus : theme.colors.border)}
              >
                <TextArea
                  value={String(value ?? '')}
                  onChange={(v) => onChange(f.key, v)}
                  focus={active}
                  height={f.rows ?? 4}
                  width={inputWidth - 2}
                  lineNumbers={false}
                  placeholder={f.placeholder}
                  tabInserts={false}
                />
              </Box>
            );
            break;
          default:
            control = f.disabled ? (
              <Text color={col(theme, theme.colors.muted)}>{String(value ?? '')}</Text>
            ) : (
              <TextInput
                value={String(value ?? '')}
                onChange={(v) => onChange(f.key, f.kind === 'number' ? v.replace(/[^\d]/g, '') : v)}
                focus={active}
                mask={f.kind === 'password'}
                placeholder={f.placeholder}
                width={inputWidth}
                onSubmit={next}
              />
            );
        }
        return (
          <Box key={f.key} flexDirection="column">
            <Box>
              <Box width={labelWidth}>
                <Text color={col(theme, labelColor)} bold={active}>
                  {active ? `${symbols.pointer} ` : '  '}
                  {truncate(f.label, labelWidth - 3)}
                </Text>
              </Box>
              {control}
            </Box>
            {errors[f.key] ? (
              <Text color={col(theme, theme.colors.error)}>
                {' '.repeat(labelWidth)}
                {truncate(errors[f.key] ?? '', inputWidth)}
              </Text>
            ) : null}
            {active && f.help ? (
              <Text color={col(theme, theme.colors.muted)}>
                {' '.repeat(labelWidth)}
                {truncate(f.help, inputWidth)}
              </Text>
            ) : null}
          </Box>
        );
      })}
      <Box marginTop={1} gap={2}>
        {actions.map((a, i) => {
          const active = focus && onActions && i === actionIndex;
          const color =
            a.tone === 'danger'
              ? theme.colors.error
              : a.tone === 'primary'
                ? theme.colors.primary
                : theme.colors.text;
          return (
            <Text key={a.key} bold={active} inverse={active} dimColor={a.disabled} color={col(theme, color)}>
              {` ${a.label} `}
            </Text>
          );
        })}
      </Box>
      {footer}
    </Box>
  );
}
