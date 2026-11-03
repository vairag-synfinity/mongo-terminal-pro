import { EJSON } from '../../utils/bson.js';
import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';
import {
  pipelineToStages,
  STAGE_TEMPLATES,
  validatePipeline,
  type AggregationResult,
  type PipelineStageInput,
} from '../../database/aggregation-manager.js';
import { Operations } from '../../security/permission-manager.js';
import { formatDuration, formatNumber, truncate } from '../../utils/formatting.js';
import { parseMongoValue } from '../../utils/validation.js';
import { useDialog } from '../components/dialog.js';
import { Loading, Muted } from '../components/feedback.js';
import { JsonView } from '../components/json-view.js';
import { Panel } from '../components/panel.js';
import { ScrollText } from '../components/scroll-text.js';
import { SelectList } from '../components/select-list.js';
import { TextArea } from '../components/text-area.js';
import { useScreenActive, useUi } from '../context.js';
import { useAsync } from '../hooks/use-async.js';
import { useDraft } from '../hooks/use-draft.js';
import { useHints, useLayout } from '../layouts/layout.js';
import { col } from '../themes/theme.js';
import { confirmOperation } from './confirm-operation.js';

type View =
  | { kind: 'stages' }
  | { kind: 'add' }
  | { kind: 'edit'; index: number; body: string }
  | { kind: 'json' }
  | { kind: 'results'; result: AggregationResult }
  | { kind: 'load' };

export function AggregationScreen({ params }: { params: { db: string; collection: string } }) {
  const { app, nav, theme, settings, symbols, notify, notifyError } = useUi();
  const screenActive = useScreenActive();
  const layout = useLayout();
  const dialog = useDialog(layout.width);
  const { db, collection } = params;
  const [stages, setStages] = useDraft<PipelineStageInput[]>(`agg:${db}.${collection}`, [
    { operator: '$match', body: '{}', enabled: true },
  ]);
  const [view, setView] = useState<View>({ kind: 'stages' });
  const [index, setIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [loadTick, setLoadTick] = useState(0);
  const active = screenActive && !dialog.open && !running;
  const validation = validatePipeline(stages);
  const savedPipelines = useAsync(() => app.history.listPipelines(), [loadTick], {
    enabled: view.kind === 'load',
  });

  const run = async () => {
    if (validation.errors.length > 0) {
      notify('error', 'Pipeline is not valid', validation.errors.slice(0, 4).join('\n'));
      return;
    }
    if (validation.writesData) {
      const ok = await confirmOperation(
        { app, dialog, notify },
        Operations.aggregationWrite,
        `Run a pipeline with $out/$merge on ${db}.${collection}?`,
        ['The target collection will be written (and $out replaces it entirely).'],
        true,
      );
      if (!ok) return;
    }
    setRunning(true);
    try {
      const result = await app.db().aggregations.run(db, collection, validation.pipeline, {
        resultLimit: settings.aggregationResultLimit,
        timeoutMs: settings.aggregationTimeoutMs,
        allowDiskUse: settings.aggregationAllowDiskUse,
      });
      setView({ kind: 'results', result });
    } catch (e) {
      notifyError(e, 'Aggregation failed');
    } finally {
      setRunning(false);
    }
  };

  const move = (delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= stages.length) return;
    setStages((s) => {
      const next = [...s];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item as PipelineStageInput);
      return next;
    });
    setIndex(target);
  };

  const importPipeline = async () => {
    const text = await dialog.prompt({
      title: 'Paste pipeline',
      label: 'Pipeline:',
      placeholder: '[ { $match: {} }, { $limit: 10 } ]',
      help: 'Paste a JSON / shell-syntax array of stages. It replaces the current pipeline.',
    });
    if (!text) return;
    try {
      setStages(pipelineToStages(parseMongoValue(text)));
      setIndex(0);
    } catch (e) {
      notifyError(e, 'Could not import pipeline');
    }
  };

  const save = async () => {
    const name = await dialog.prompt({
      title: 'Save pipeline',
      label: 'Name:',
      validate: (v) => (v.trim() ? undefined : 'Name is required'),
    });
    if (!name) return;
    await app.history.savePipeline({
      name: name.trim(),
      database: db,
      collection,
      stages: stages.map((s) => ({ operator: s.operator, body: s.body, enabled: s.enabled !== false })),
    });
    notify('success', `Saved pipeline "${name.trim()}"`);
  };

  useHints(
    view.kind === 'stages'
      ? [
          { key: 'Enter', label: 'edit' },
          { key: 'a', label: 'add' },
          { key: 'x', label: 'remove' },
          { key: 'K/J', label: 'move' },
          { key: 'Space', label: 'on/off' },
          { key: 'Ctrl+R', label: 'run' },
          { key: 'v', label: 'JSON' },
          { key: 'p', label: 'paste' },
          { key: 's', label: 'save' },
          { key: 'l', label: 'load' },
          { key: 'Esc', label: 'back' },
        ]
      : view.kind === 'edit'
        ? [
            { key: 'Ctrl+S', label: 'apply' },
            { key: 'Esc', label: 'cancel' },
          ]
        : [{ key: 'Esc', label: 'back to stages' }],
    [view.kind],
  );

  useInput(
    (input, key) => {
      if (view.kind === 'stages') {
        if (key.escape) return nav.back();
        if (key.ctrl && input === 'r') return void run();
        if (input === 'a') setView({ kind: 'add' });
        else if ((input === 'x' || key.delete) && stages.length > 0) {
          setStages((s) => s.filter((_, i) => i !== index));
          setIndex((i) => Math.max(0, i - 1));
        } else if (input === 'K') move(-1);
        else if (input === 'J') move(1);
        else if (input === ' ' && stages[index])
          setStages((s) => s.map((st, i) => (i === index ? { ...st, enabled: st.enabled === false } : st)));
        else if (input === 'v') setView({ kind: 'json' });
        else if (input === 'p') void importPipeline();
        else if (input === 's') void save();
        else if (input === 'l') setView({ kind: 'load' });
        return;
      }
      if (view.kind === 'edit' || view.kind === 'add' || view.kind === 'load') return;
      if (key.escape) setView({ kind: 'stages' });
    },
    { isActive: active },
  );

  if (dialog.open) return <Box justifyContent="center">{dialog.element}</Box>;
  if (running)
    return (
      <Loading
        label={`Running pipeline (timeout ${formatDuration(settings.aggregationTimeoutMs)}, max ${settings.aggregationResultLimit} docs)…`}
      />
    );

  if (view.kind === 'add') {
    return (
      <Panel title="Add stage" focus>
        <SelectList
          items={STAGE_TEMPLATES.map((t) => ({
            key: t.operator,
            label: t.operator,
            value: t,
            hint: t.description,
            description: `Template: ${t.template}`,
          }))}
          focus={active}
          height={layout.height - 4}
          width={layout.width - 4}
          searchable
          onSelect={(item) => {
            const at = stages.length === 0 ? 0 : index + 1;
            setStages((s) => [
              ...s.slice(0, at),
              { operator: item.value.operator, body: item.value.template, enabled: true },
              ...s.slice(at),
            ]);
            setIndex(at);
            setView({ kind: 'edit', index: at, body: item.value.template });
          }}
          onKey={(input) => {
            if (input === 'q') setView({ kind: 'stages' });
          }}
        />
        <Muted>Enter adds after the selected stage · / filter · Esc (or q) cancel</Muted>
        <EscBack active={active} onBack={() => setView({ kind: 'stages' })} />
      </Panel>
    );
  }

  if (view.kind === 'load') {
    const list = (savedPipelines.data ?? []).filter((p) => p.database === db && p.collection === collection);
    return (
      <Panel title={`Saved pipelines for ${db}.${collection}`} focus>
        {savedPipelines.loading ? (
          <Loading />
        ) : (
          <SelectList
            items={list.map((p) => ({
              key: p.id,
              label: p.name,
              value: p,
              hint: `${p.stages.length} stage(s)`,
            }))}
            focus={active}
            height={layout.height - 4}
            width={layout.width - 4}
            emptyText="No saved pipelines for this collection"
            onSelect={(item) => {
              setStages(item.value.stages);
              setIndex(0);
              setView({ kind: 'stages' });
            }}
            onKey={(input, item) => {
              if (input === 'd' && item)
                void app.history.deletePipeline(item.value.id).then(() => setLoadTick((t) => t + 1));
            }}
          />
        )}
        <Muted>Enter load · d delete · Esc back</Muted>
        <EscBack active={active} onBack={() => setView({ kind: 'stages' })} />
      </Panel>
    );
  }

  if (view.kind === 'edit') {
    const stage = stages[view.index];
    return (
      <Panel
        title={`Stage ${view.index + 1}: ${stage?.operator ?? ''}`}
        right={STAGE_TEMPLATES.find((t) => t.operator === stage?.operator)?.description}
        focus
      >
        <TextArea
          value={view.body}
          onChange={(body) => setView({ ...view, body })}
          focus={active}
          height={layout.height - 5}
          width={layout.width - 4}
          onSubmit={(body) => {
            setStages((s) => s.map((st, i) => (i === view.index ? { ...st, body } : st)));
            setView({ kind: 'stages' });
          }}
          onCancel={() => setView({ kind: 'stages' })}
        />
        <Muted>Ctrl+S apply · Esc cancel · body only, e.g. {'{ status: "A" }'} for $match</Muted>
      </Panel>
    );
  }

  if (view.kind === 'json') {
    const text = EJSON.stringify(validation.pipeline, undefined, 2, { relaxed: true });
    return (
      <Panel
        title="Pipeline JSON"
        right={validation.errors.length ? `${validation.errors.length} error(s)` : 'valid'}
        focus
      >
        <ScrollText
          lines={text.split('\n')}
          height={layout.height - 4}
          width={layout.width - 4}
          focus={active}
        />
      </Panel>
    );
  }

  if (view.kind === 'results') {
    const r = view.result;
    return (
      <Panel
        title={`Results · ${db}.${collection}`}
        right={`${formatNumber(r.returned)} doc(s)${r.truncated ? ` (limit ${settings.aggregationResultLimit} reached)` : ''} · ${formatDuration(r.durationMs)}`}
        focus
      >
        {r.wroteData ? (
          <Text color={col(theme, theme.colors.warning)}>
            {symbols.warning} The pipeline wrote its output to a collection.
          </Text>
        ) : null}
        <JsonView
          value={r.documents}
          focus={active}
          height={layout.height - 4 - (r.wroteData ? 1 : 0)}
          width={layout.width - 4}
          initialDepth={1}
        />
      </Panel>
    );
  }

  const listWidth = layout.wide ? Math.floor(layout.width * 0.5) : layout.width - 2;
  const selected = stages[index];
  const msgLines = [
    ...validation.errors.map((e) => ({ text: `${symbols.cross} ${e}`, color: theme.colors.error })),
    ...validation.warnings.map((w) => ({ text: `${symbols.warning} ${w}`, color: theme.colors.warning })),
  ].slice(0, 4);
  return (
    <Box flexDirection="column">
      <Box flexDirection={layout.wide ? 'row' : 'column'}>
        <Panel
          title={`Pipeline · ${db}.${collection}`}
          right={`${stages.length} stage(s)`}
          focus
          width={listWidth}
        >
          <SelectList
            items={stages.map((s, i) => ({
              key: `${i}-${s.operator}`,
              label: `${s.enabled === false ? symbols.checkboxOff : symbols.checkboxOn} ${s.operator}  ${truncate(s.body.replace(/\s+/g, ' '), listWidth - 20)}`,
              value: i,
              color: s.enabled === false ? theme.colors.muted : undefined,
              shortcut: String(i + 1),
            }))}
            focus={active}
            height={Math.max(
              3,
              layout.wide
                ? layout.height - 4 - msgLines.length
                : Math.min(stages.length + 1, layout.height - 12),
            )}
            width={listWidth - 4}
            showDescription={false}
            initialIndex={index}
            emptyText="No stages — press a to add one"
            onHighlight={(item) => item && setIndex(item.value)}
            onSelect={(item) =>
              setView({ kind: 'edit', index: item.value, body: stages[item.value]?.body ?? '' })
            }
          />
        </Panel>
        {selected ? (
          <Panel title={`Stage ${index + 1}: ${selected.operator}`} flexGrow={1}>
            <ScrollText
              lines={selected.body.split('\n')}
              height={Math.max(3, layout.wide ? layout.height - 6 - msgLines.length : 5)}
              width={layout.wide ? layout.width - listWidth - 6 : layout.width - 6}
              focus={false}
            />
          </Panel>
        ) : null}
      </Box>
      {msgLines.map((m, i) => (
        <Text key={i} color={col(theme, m.color)} wrap="truncate-end">
          {m.text}
        </Text>
      ))}
      <Muted>
        Results capped at {settings.aggregationResultLimit} docs · timeout{' '}
        {formatDuration(settings.aggregationTimeoutMs)} · allowDiskUse{' '}
        {settings.aggregationAllowDiskUse ? 'on' : 'off'}
      </Muted>
    </Box>
  );
}

function EscBack({ active, onBack }: { active: boolean; onBack(): void }) {
  useInput(
    (_i, key) => {
      if (key.escape) onBack();
    },
    { isActive: active },
  );
  return null;
}
