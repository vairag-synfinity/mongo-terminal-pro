import { Box, Text, useInput } from 'ink';
import React, { useCallback, useRef, useState } from 'react';
import { useUi } from '../context.js';
import { col } from '../themes/theme.js';
import { TextInput } from './text-input.js';

export interface ConfirmOptions {
  title: string;
  message: string | string[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** When set, the user must type this exact text (e.g. the connection name) to confirm. */
  typeToConfirm?: string;
}

export interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  mask?: boolean;
  help?: string | string[];
  validate?(value: string): string | undefined;
}

function DialogFrame({
  title,
  danger,
  children,
  width,
}: {
  title: string;
  danger?: boolean;
  children: React.ReactNode;
  width: number;
}) {
  const { theme, symbols } = useUi();
  return (
    <Box
      flexDirection="column"
      borderStyle={symbols.strongBorderStyle}
      borderColor={col(theme, danger ? theme.colors.error : theme.colors.borderFocus)}
      paddingX={2}
      paddingY={0}
      width={width}
    >
      <Text bold color={col(theme, danger ? theme.colors.error : theme.colors.title)}>
        {danger ? `${symbols.warning} ` : ''}
        {title}
      </Text>
      {children}
    </Box>
  );
}

export function ConfirmDialog({
  options,
  onResult,
  width,
}: {
  options: ConfirmOptions;
  onResult(ok: boolean): void;
  width: number;
}) {
  const { theme } = useUi();
  const [choice, setChoice] = useState<0 | 1>(1); // default to Cancel
  const [typed, setTyped] = useState('');
  const lines = Array.isArray(options.message) ? options.message : [options.message];
  const needsTyping = options.typeToConfirm !== undefined;

  useInput(
    (input, key) => {
      if (key.escape) return onResult(false);
      if (needsTyping) return;
      if (key.leftArrow || key.rightArrow || key.tab) setChoice((c) => (c === 0 ? 1 : 0));
      else if (input === 'y' || input === 'Y') onResult(true);
      else if (input === 'n' || input === 'N') onResult(false);
      else if (key.return) onResult(choice === 0);
    },
    { isActive: true },
  );

  const button = (label: string, active: boolean, danger?: boolean) => (
    <Text
      bold={active}
      inverse={active}
      color={col(theme, danger ? theme.colors.error : theme.colors.primary)}
    >
      {` ${label} `}
    </Text>
  );

  return (
    <DialogFrame title={options.title} danger={options.danger} width={width}>
      {lines.map((l, i) => (
        <Text key={i} wrap="wrap">
          {l}
        </Text>
      ))}
      <Box marginTop={1} flexDirection="column">
        {needsTyping ? (
          <>
            <Text>
              Type{' '}
              <Text bold color={col(theme, theme.colors.warning)}>
                {options.typeToConfirm}
              </Text>{' '}
              to confirm (Esc to cancel):
            </Text>
            <Box>
              <Text color={col(theme, theme.colors.accent)}>{'> '}</Text>
              <TextInput
                value={typed}
                onChange={setTyped}
                focus
                width={Math.max(20, width - 8)}
                onSubmit={(v) => onResult(v === options.typeToConfirm)}
                onCancel={() => onResult(false)}
              />
            </Box>
            {typed && typed !== options.typeToConfirm ? (
              <Text color={col(theme, theme.colors.muted)}>Does not match yet.</Text>
            ) : null}
          </>
        ) : (
          <Box gap={2}>
            {button(options.confirmLabel ?? 'Yes', choice === 0, options.danger)}
            {button(options.cancelLabel ?? 'Cancel', choice === 1)}
            <Text color={col(theme, theme.colors.muted)}>y/n · ←→ · Enter</Text>
          </Box>
        )}
      </Box>
    </DialogFrame>
  );
}

export function PromptDialog({
  options,
  onResult,
  width,
}: {
  options: PromptOptions;
  onResult(value: string | undefined): void;
  width: number;
}) {
  const { theme } = useUi();
  const [value, setValue] = useState(options.initial ?? '');
  const [error, setError] = useState<string | undefined>();
  const help = options.help === undefined ? [] : Array.isArray(options.help) ? options.help : [options.help];
  const submit = (v: string) => {
    const e = options.validate?.(v);
    if (e) setError(e);
    else onResult(v);
  };
  return (
    <DialogFrame title={options.title} width={width}>
      {help.map((h, i) => (
        <Text key={i} color={col(theme, theme.colors.muted)} wrap="wrap">
          {h}
        </Text>
      ))}
      <Box marginTop={help.length ? 1 : 0}>
        <Text bold>{options.label} </Text>
        <TextInput
          value={value}
          onChange={(v) => {
            setValue(v);
            setError(undefined);
          }}
          focus
          mask={options.mask}
          placeholder={options.placeholder}
          width={Math.max(20, width - options.label.length - 8)}
          onSubmit={submit}
          onCancel={() => onResult(undefined)}
        />
      </Box>
      {error ? (
        <Text color={col(theme, theme.colors.error)}>{error}</Text>
      ) : (
        <Text color={col(theme, theme.colors.muted)}>Enter to confirm · Esc to cancel</Text>
      )}
    </DialogFrame>
  );
}

type DialogState =
  | { kind: 'confirm'; options: ConfirmOptions; resolve(ok: boolean): void }
  | { kind: 'prompt'; options: PromptOptions; resolve(v: string | undefined): void };

/**
 * Promise-based dialogs for screens. While `open` is true the screen should disable its own input
 * handling and render `element` instead of (or above) its content.
 */
export function useDialog(width: number) {
  const [state, setState] = useState<DialogState | undefined>();
  const stateRef = useRef(state);
  stateRef.current = state;

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setState({ kind: 'confirm', options, resolve })),
    [],
  );
  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | undefined>((resolve) => setState({ kind: 'prompt', options, resolve })),
    [],
  );

  const dialogWidth = Math.min(Math.max(40, width - 4), 90);
  let element: React.ReactNode = null;
  if (state?.kind === 'confirm') {
    element = (
      <ConfirmDialog
        options={state.options}
        width={dialogWidth}
        onResult={(ok) => {
          setState(undefined);
          state.resolve(ok);
        }}
      />
    );
  } else if (state?.kind === 'prompt') {
    element = (
      <PromptDialog
        options={state.options}
        width={dialogWidth}
        onResult={(v) => {
          setState(undefined);
          state.resolve(v);
        }}
      />
    );
  }
  return { open: state !== undefined, element, confirm, prompt };
}
