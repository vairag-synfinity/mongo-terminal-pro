import { Box, Text } from 'ink';
import React, { useMemo, useState } from 'react';
import { profileToDraft } from '../../connection/connection-storage.js';
import type {
  ConnectionDraft,
  ConnectionKind,
  ConnectionProfile,
} from '../../connection/connection-types.js';
import { validateDraft } from '../../connection/connection-validator.js';
import {
  buildConnectionFromDraft,
  detectKind,
  parseConnectionString,
} from '../../connection/manual-connection.js';
import type { TestResult } from '../../connection/connection-manager.js';
import { toFriendlyError } from '../../core/error-handler.js';
import { Loading } from '../components/feedback.js';
import { Form, type FieldDef } from '../components/form.js';
import { Panel } from '../components/panel.js';
import { useUi } from '../context.js';
import { useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';

interface FormValues {
  name: string;
  kind: ConnectionKind;
  useUri: boolean;
  uri: string;
  host: string;
  port: string;
  srv: boolean;
  replicaSet: string;
  username: string;
  password: string;
  authSource: string;
  authMechanism: string;
  defaultDatabase: string;
  tlsMode: 'default' | 'on' | 'off';
  caFile: string;
  certificateKeyFile: string;
  allowInvalidCertificates: boolean;
  connectTimeoutMs: string;
  production: boolean;
  readOnlyLocked: boolean;
  favorite: boolean;
  savePassword: boolean;
  forgetPassword: boolean;
}

function initialValues(profile?: ConnectionProfile): FormValues {
  const draft = profile ? profileToDraft(profile) : undefined;
  let host = 'localhost';
  let port = '27017';
  let srv = false;
  let replicaSet = '';
  if (profile) {
    try {
      const cs = parseConnectionString(profile.uri);
      srv = cs.isSRV;
      const first = cs.hosts[0] ?? 'localhost';
      host = cs.hosts.map((h) => h.replace(/:\d+$/, '')).join(',');
      port = /:(\d+)$/.exec(first)?.[1] ?? '27017';
      replicaSet = cs.searchParams.get('replicaSet') ?? '';
    } catch {
      // keep defaults
    }
  }
  return {
    name: draft?.name ?? '',
    kind: draft?.kind ?? 'local',
    useUri: true,
    uri: profile?.uri ?? 'mongodb://localhost:27017',
    host,
    port,
    srv,
    replicaSet,
    username: draft?.username ?? '',
    password: '',
    authSource: draft?.authSource ?? '',
    authMechanism: draft?.authMechanism ?? '',
    defaultDatabase: draft?.defaultDatabase ?? '',
    tlsMode: profile?.tls.mode ?? 'default',
    caFile: profile?.tls.caFile ?? '',
    certificateKeyFile: profile?.tls.certificateKeyFile ?? '',
    allowInvalidCertificates: profile?.tls.allowInvalidCertificates ?? false,
    connectTimeoutMs: profile?.connectTimeoutMs ? String(profile.connectTimeoutMs) : '',
    production: profile?.production ?? false,
    readOnlyLocked: profile?.readOnlyLocked ?? false,
    favorite: profile?.favorite ?? false,
    savePassword: profile?.hasStoredPassword ?? true,
    forgetPassword: false,
  };
}

function toDraft(v: FormValues, editing?: ConnectionProfile): ConnectionDraft {
  return {
    name: v.name,
    kind: v.kind,
    uri: v.useUri ? v.uri : undefined,
    host: v.useUri ? undefined : v.host,
    port: v.useUri || v.srv ? undefined : Number(v.port || 27017),
    srv: v.srv,
    replicaSet: v.replicaSet || undefined,
    username: v.username || undefined,
    // Edit: blank password keeps the stored one; "forget" removes it.
    password: v.forgetPassword ? '' : v.password || undefined,
    authSource: v.authSource || undefined,
    authMechanism: v.authMechanism || undefined,
    defaultDatabase: v.defaultDatabase || undefined,
    tls: {
      mode: v.tlsMode,
      caFile: v.caFile || undefined,
      certificateKeyFile: v.certificateKeyFile || undefined,
      allowInvalidCertificates: v.allowInvalidCertificates,
      allowInvalidHostnames: v.allowInvalidCertificates,
    },
    connectTimeoutMs: v.connectTimeoutMs ? Number(v.connectTimeoutMs) : undefined,
    production: v.production,
    readOnlyLocked: v.readOnlyLocked,
    favorite: v.favorite,
    source: editing?.source ?? 'manual',
  };
}

export function ConnectionForm({
  editing,
  onDone,
  active,
}: {
  editing?: ConnectionProfile;
  onDone(saved?: ConnectionProfile): void;
  active: boolean;
}) {
  const { app, theme, symbols, notify, notifyError } = useUi();
  const layout = useLayout();
  const [values, setValues] = useState<FormValues>(() => initialValues(editing));
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | undefined>();
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  const set = (key: string, value: unknown) => {
    setValues((v) => {
      const next = { ...v, [key]: value } as FormValues;
      if (key === 'uri' && typeof value === 'string' && !editing) {
        next.kind = detectKind(value);
      }
      return next;
    });
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const draft = useMemo(() => toDraft(values, editing), [values, editing]);
  const warnings = useMemo(() => {
    const others: string[] = [];
    return validateDraft(draft, others).warnings;
  }, [draft]);

  const validate = async (): Promise<boolean> => {
    const names = (await app.connections.list()).filter((p) => p.id !== editing?.id).map((p) => p.name);
    const result = validateDraft(draft, names);
    setErrors(result.errors as Record<string, string | undefined>);
    return result.valid;
  };

  const test = async () => {
    if (!(await validate())) return;
    setTesting(true);
    setTestResult(undefined);
    try {
      const n = buildConnectionFromDraft(draft);
      let password = n.password;
      if (password === undefined && editing && !values.forgetPassword)
        password = await app.connections.getPassword(editing.id).catch(() => undefined);
      const result = await app.connectionManager.test(
        {
          uri: n.uri,
          username: n.username,
          authSource: n.authSource,
          authMechanism: n.authMechanism,
          tls: {
            mode: values.tlsMode,
            caFile: values.caFile || undefined,
            certificateKeyFile: values.certificateKeyFile || undefined,
            allowInvalidCertificates: values.allowInvalidCertificates,
            allowInvalidHostnames: values.allowInvalidCertificates,
          },
          connectTimeoutMs: draft.connectTimeoutMs,
        },
        password,
      );
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, latencyMs: 0, error: e });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!(await validate())) return;
    setSaving(true);
    try {
      const saved = editing
        ? await app.connections.updateFromDraft(editing.id, draft, { savePassword: values.savePassword })
        : await app.connections.create(draft, { savePassword: values.savePassword });
      const backend = await app.credentials.backend();
      notify(
        'success',
        `Connection "${saved.name}" saved`,
        saved.hasStoredPassword ? `Password stored in ${backend.description}` : undefined,
      );
      if (app.credentials.fallbackReason && saved.hasStoredPassword)
        notify('warning', 'Credential storage', app.credentials.fallbackReason);
      onDone(saved);
    } catch (e) {
      notifyError(e, 'Could not save connection');
    } finally {
      setSaving(false);
    }
  };

  const mechOptions = [
    '',
    'SCRAM-SHA-256',
    'SCRAM-SHA-1',
    'MONGODB-X509',
    'MONGODB-AWS',
    'GSSAPI',
    'PLAIN',
    'MONGODB-OIDC',
  ].map((m) => ({ label: m || 'default (SCRAM)', value: m }));
  const fields: FieldDef[] = [
    { key: 'name', label: 'Connection name', kind: 'text', placeholder: 'e.g. Local dev, Production Atlas' },
    { key: 'useUri', label: 'Use connection string', kind: 'toggle', help: 'Off = enter host/port fields' },
    {
      key: 'uri',
      label: 'Connection URI',
      kind: 'text',
      hidden: !values.useUri,
      placeholder: 'mongodb+srv://cluster0.example.mongodb.net',
      help: 'A password in the URI is moved to secure storage',
    },
    {
      key: 'host',
      label: 'Host(s)',
      kind: 'text',
      hidden: values.useUri,
      help: 'Comma-separate replica set members',
    },
    { key: 'port', label: 'Port', kind: 'number', hidden: values.useUri || values.srv },
    {
      key: 'srv',
      label: 'DNS seed list (+srv)',
      kind: 'toggle',
      hidden: values.useUri,
      help: 'Atlas uses mongodb+srv',
    },
    { key: 'replicaSet', label: 'Replica set name', kind: 'text', hidden: values.useUri },
    {
      key: 'kind',
      label: 'Connection type',
      kind: 'select',
      options: ['local', 'atlas', 'self-hosted', 'replica-set', 'sharded'].map((k) => ({
        label: k,
        value: k,
      })),
    },
    { key: 'username', label: 'Username', kind: 'text' },
    {
      key: 'password',
      label: 'Password',
      kind: 'password',
      placeholder: editing?.hasStoredPassword ? '(unchanged)' : '',
    },
    {
      key: 'savePassword',
      label: 'Remember password',
      kind: 'toggle',
      help: 'Stored in the OS keychain (or encrypted file fallback)',
    },
    {
      key: 'forgetPassword',
      label: 'Forget stored password',
      kind: 'toggle',
      hidden: !editing?.hasStoredPassword,
    },
    { key: 'authSource', label: 'Auth database', kind: 'text', placeholder: 'admin' },
    { key: 'authMechanism', label: 'Auth mechanism', kind: 'select', options: mechOptions },
    { key: 'defaultDatabase', label: 'Default database', kind: 'text' },
    {
      key: 'tlsMode',
      label: 'TLS',
      kind: 'select',
      options: [
        { label: 'default (per URI)', value: 'default' },
        { label: 'on', value: 'on' },
        { label: 'off', value: 'off' },
      ],
    },
    { key: 'caFile', label: 'TLS CA file', kind: 'text', hidden: values.tlsMode === 'off' },
    {
      key: 'certificateKeyFile',
      label: 'TLS client cert (PEM)',
      kind: 'text',
      hidden: values.tlsMode === 'off',
    },
    {
      key: 'allowInvalidCertificates',
      label: 'Allow invalid certs',
      kind: 'toggle',
      hidden: values.tlsMode === 'off',
      help: 'INSECURE — local testing only',
    },
    { key: 'connectTimeoutMs', label: 'Timeout (ms)', kind: 'number', placeholder: 'default from settings' },
    {
      key: 'production',
      label: 'Production database',
      kind: 'toggle',
      help: 'Requires typing the name to enable writes',
    },
    {
      key: 'readOnlyLocked',
      label: 'Lock read-only',
      kind: 'toggle',
      help: 'Write access can never be enabled',
    },
    { key: 'favorite', label: 'Favorite', kind: 'toggle' },
  ];

  const footer = (
    <Box flexDirection="column" marginTop={1}>
      {testing ? <Loading label="Testing connection…" /> : null}
      {testResult ? (
        testResult.ok ? (
          <Text color={col(theme, theme.colors.success)}>
            {symbols.check} Connected in {testResult.latencyMs} ms — MongoDB {testResult.server?.version} (
            {testResult.server?.topology}
            {testResult.server?.isAtlas ? ', Atlas' : ''})
          </Text>
        ) : (
          <Box flexDirection="column">
            <Text color={col(theme, theme.colors.error)} wrap="truncate-end">
              {symbols.cross} {toFriendlyError(testResult.error).title}:{' '}
              {toFriendlyError(testResult.error).message}
            </Text>
            {toFriendlyError(testResult.error).hint ? (
              <Text color={col(theme, theme.colors.muted)} wrap="truncate-end">
                {toFriendlyError(testResult.error).hint}
              </Text>
            ) : null}
          </Box>
        )
      ) : null}
      {warnings.map((w, i) => (
        <Text key={i} color={col(theme, theme.colors.warning)} wrap="truncate-end">
          {symbols.warning} {w}
        </Text>
      ))}
      <Text color={col(theme, theme.colors.muted)} wrap="truncate-end">
        SSH tunnel: run `ssh -N -L 27018:db-host:27017 user@bastion`, then connect to localhost:27018
        (docs/connection-guide.md).
      </Text>
    </Box>
  );

  return (
    <Panel title={editing ? `Edit connection · ${editing.name}` : 'New connection'} focus>
      <Form
        fields={fields}
        values={values as unknown as Record<string, unknown>}
        onChange={set}
        errors={errors}
        focus={active && !saving}
        width={layout.width - 4}
        height={layout.height - 9 - warnings.length}
        onCancel={() => onDone(undefined)}
        actions={[
          {
            key: 'test',
            label: testing ? 'Testing…' : 'Test Connection',
            onPress: () => void test(),
            disabled: testing,
          },
          {
            key: 'save',
            label: saving ? 'Saving…' : 'Save',
            tone: 'primary',
            onPress: () => void save(),
            disabled: saving,
          },
          { key: 'cancel', label: 'Cancel', onPress: () => onDone(undefined) },
        ]}
        footer={footer}
      />
    </Panel>
  );
}
