import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';
import type { MonitoringSnapshot } from '../../database/monitoring-manager.js';
import { formatBytes, formatDateTime, formatDuration, formatNumber } from '../../utils/formatting.js';
import { ErrorBox, Loading, Muted } from '../components/feedback.js';
import { Panel } from '../components/panel.js';
import { useScreenActive, useUi } from '../context.js';
import { useAsync } from '../hooks/use-async.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';

const INTERVALS = [0, 5, 10, 30, 60];

export function MonitoringScreen() {
  const { app, nav, theme, settings, symbols } = useUi();
  const active = useScreenActive();
  const layout = useLayout();
  const [tick, setTick] = useState(0);
  const [includeDbs, setIncludeDbs] = useState(false);
  const [interval, setIntervalSeconds] = useState(settings.monitoringRefreshSeconds);
  const snap = useAsync<MonitoringSnapshot>(
    () => app.monitoring().snapshot({ includeDatabases: includeDbs }),
    [tick, includeDbs],
  );

  // Background refresh only when explicitly configured; never faster than 5 s.
  useEffect(() => {
    if (!interval) return;
    const id = setInterval(() => setTick((t) => t + 1), Math.max(5, interval) * 1000);
    return () => clearInterval(id);
  }, [interval]);

  useHints(
    [
      { key: 'r', label: 'refresh' },
      { key: 'a', label: `auto:${interval ? `${interval}s` : 'off'}` },
      { key: 'd', label: includeDbs ? 'hide db stats' : 'db stats' },
      { key: 'Esc', label: 'back' },
    ],
    [interval, includeDbs],
  );

  useInput(
    (input, key) => {
      if (key.escape) return nav.back();
      if (input === 'r') setTick((t) => t + 1);
      else if (input === 'a')
        setIntervalSeconds((s) => INTERVALS[(INTERVALS.indexOf(s) + 1) % INTERVALS.length] ?? 0);
      else if (input === 'd') setIncludeDbs((v) => !v);
    },
    { isActive: active },
  );

  if (snap.loading && !snap.data) return <Loading label="Collecting statistics…" />;
  if (snap.error) return <ErrorBox error={snap.error} />;
  const s = snap.data as MonitoringSnapshot;
  const status = s.serverStatus.data;
  const colWidth = layout.wide ? Math.floor((layout.width - 2) / 2) : layout.width - 2;
  const kv = (k: string, v: React.ReactNode) => (
    <Text key={k} wrap="truncate-end">
      <Text color={col(theme, theme.colors.muted)}>{k.padEnd(20)}</Text>
      {v}
    </Text>
  );
  const left = (
    <Box flexDirection="column" width={colWidth}>
      <Panel title="Connection">
        {kv(
          'Status',
          <Text color={col(theme, s.connected ? theme.colors.success : theme.colors.error)}>
            {symbols.bullet} {s.connected ? 'connected' : 'unreachable'}
          </Text>,
        )}
        {kv('Ping', s.pingMs === undefined ? '—' : `${s.pingMs} ms`)}
        {kv('Server version', s.server?.version ?? '—')}
        {kv('Topology', `${s.server?.topology ?? '—'}${s.server?.isAtlas ? ' (Atlas)' : ''}`)}
        {kv('Hosts', s.server?.displayHosts ?? '—')}
        {kv(
          'Pool (this client)',
          `max ${s.pool.maxPoolSize ?? '—'} · min ${s.pool.minPoolSize ?? 0} · idle ${formatDuration(s.pool.maxIdleTimeMS ?? 0)}`,
        )}
        {kv(
          'Timeouts',
          `select ${formatDuration(s.pool.serverSelectionTimeoutMS ?? 0)} · connect ${formatDuration(s.pool.connectTimeoutMS ?? 0)}`,
        )}
      </Panel>
      <Panel title="Replica set">
        {s.replicaSet.available && s.replicaSet.data ? (
          <>
            {kv('Set', s.replicaSet.data.set)}
            {s.replicaSet.data.members.slice(0, 7).map((m) => (
              <Text key={m.name} wrap="truncate-end">
                <Text color={col(theme, m.health ? theme.colors.success : theme.colors.error)}>
                  {symbols.bullet}{' '}
                </Text>
                {m.name} <Text bold>{m.state}</Text>
                {m.lagSeconds !== undefined && m.state === 'SECONDARY' ? (
                  <Text color={col(theme, theme.colors.muted)}> lag {m.lagSeconds.toFixed(0)}s</Text>
                ) : null}
                {m.self ? <Text color={col(theme, theme.colors.muted)}> (this node)</Text> : null}
              </Text>
            ))}
          </>
        ) : (
          <Muted>{s.replicaSet.reason ?? 'unavailable'}</Muted>
        )}
      </Panel>
    </Box>
  );
  const right = (
    <Box flexDirection="column" width={colWidth}>
      <Panel title="Server status">
        {s.serverStatus.available && status ? (
          <>
            {kv('Host', status.host ?? '—')}
            {kv('Uptime', formatDuration((status.uptimeSeconds ?? 0) * 1000))}
            {kv('Storage engine', status.storageEngine ?? '—')}
            {status.connections
              ? kv(
                  'Connections',
                  `${formatNumber(status.connections.current)} current · ${formatNumber(status.connections.available)} available`,
                )
              : null}
            {status.memoryMB ? kv('Memory', `${formatNumber(status.memoryMB.resident)} MB resident`) : null}
            {status.network
              ? kv(
                  'Network',
                  `in ${formatBytes(status.network.bytesIn)} · out ${formatBytes(status.network.bytesOut)}`,
                )
              : null}
            {status.opcounters
              ? kv(
                  'Ops/s',
                  s.opsPerSecond
                    ? ['insert', 'query', 'update', 'delete', 'getmore', 'command']
                        .map((k) => `${k} ${(s.opsPerSecond?.[k] ?? 0).toFixed(1)}`)
                        .join(' · ')
                    : 'refresh again to compute rates',
                )
              : null}
          </>
        ) : (
          <Muted>
            serverStatus unavailable ({s.serverStatus.reason}). It requires the clusterMonitor role.
          </Muted>
        )}
      </Panel>
      {includeDbs ? (
        <Panel title="Databases">
          {(s.databases?.databases ?? []).slice(0, Math.max(3, layout.height - 22)).map((d) => (
            <Text key={d.name} wrap="truncate-end">
              {d.name.padEnd(20)} {formatBytes(d.stats?.storageSize ?? d.sizeOnDisk).padStart(10)}{' '}
              {formatNumber(d.stats?.collections)} colls · ~{formatNumber(d.stats?.objects)} docs ·{' '}
              {formatNumber(d.stats?.indexes)} idx
            </Text>
          ))}
        </Panel>
      ) : null}
    </Box>
  );
  return (
    <Box flexDirection="column">
      <Box flexDirection={layout.wide ? 'row' : 'column'}>
        {left}
        {layout.wide || !layout.compact ? right : null}
      </Box>
      <Muted>
        Snapshot {formatDateTime(s.takenAt)}
        {snap.loading ? ' · refreshing…' : ''} · Statistics visible to this user via supported commands — not
        a complete server-wide monitoring solution.
      </Muted>
    </Box>
  );
}
