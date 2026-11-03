import { EJSON } from '../utils/bson.js';
import type { Document, MongoClient } from 'mongodb';
import { ValidationError } from '../core/error-handler.js';
import { Operations, type PermissionManager } from '../security/permission-manager.js';
import { isPlainObject, parseMongoValue } from '../utils/validation.js';
import { elapsed, takeFromCursor } from './helpers.js';

export interface StageTemplate {
  operator: string;
  template: string;
  description: string;
}

/** Stages offered in the builder, with editable templates. */
export const STAGE_TEMPLATES: StageTemplate[] = [
  { operator: '$match', template: '{ status: "active" }', description: 'Filter documents' },
  {
    operator: '$project',
    template: '{ _id: 0, name: 1 }',
    description: 'Include, exclude or compute fields',
  },
  {
    operator: '$group',
    template: '{ _id: "$field", count: { $sum: 1 } }',
    description: 'Group and accumulate',
  },
  { operator: '$sort', template: '{ count: -1 }', description: 'Sort documents' },
  { operator: '$limit', template: '10', description: 'Limit the number of documents' },
  { operator: '$skip', template: '0', description: 'Skip documents' },
  {
    operator: '$lookup',
    template: '{ from: "other", localField: "otherId", foreignField: "_id", as: "other" }',
    description: 'Join another collection',
  },
  {
    operator: '$unwind',
    template: '{ path: "$items", preserveNullAndEmptyArrays: false }',
    description: 'Deconstruct an array',
  },
  {
    operator: '$addFields',
    template: '{ total: { $sum: "$items.price" } }',
    description: 'Add computed fields',
  },
  { operator: '$set', template: '{ updatedAt: "$$NOW" }', description: 'Alias of $addFields' },
  { operator: '$count', template: '"total"', description: 'Count documents into a field' },
  {
    operator: '$facet',
    template: '{ byStatus: [ { $sortByCount: "$status" } ], total: [ { $count: "n" } ] }',
    description: 'Run multiple sub-pipelines',
  },
  {
    operator: '$bucket',
    template:
      '{ groupBy: "$age", boundaries: [0, 18, 65, 120], default: "other", output: { count: { $sum: 1 } } }',
    description: 'Group into ranges',
  },
  { operator: '$replaceRoot', template: '{ newRoot: "$embedded" }', description: 'Promote a sub-document' },
  { operator: '$unset', template: '["field"]', description: 'Remove fields' },
  { operator: '$sample', template: '{ size: 10 }', description: 'Random sample' },
  { operator: '$sortByCount', template: '"$field"', description: 'Group, count and sort' },
  {
    operator: '$bucketAuto',
    template: '{ groupBy: "$price", buckets: 5 }',
    description: 'Automatic buckets',
  },
  { operator: '$replaceWith', template: '"$embedded"', description: 'Alias of $replaceRoot' },
];

const KNOWN_STAGES = new Set([
  ...STAGE_TEMPLATES.map((s) => s.operator),
  '$geoNear',
  '$graphLookup',
  '$indexStats',
  '$collStats',
  '$densify',
  '$fill',
  '$redact',
  '$setWindowFields',
  '$unionWith',
  '$documents',
  '$search',
  '$searchMeta',
  '$vectorSearch',
  '$listSessions',
  '$out',
  '$merge',
]);

const WRITE_STAGES = new Set(['$out', '$merge']);

export interface PipelineStageInput {
  operator: string;
  /** Stage body as typed by the user (shell-style JSON). */
  body: string;
  enabled?: boolean;
}

export interface PipelineValidation {
  pipeline: Document[];
  errors: string[];
  warnings: string[];
  writesData: boolean;
}

function requireKeys(stage: string, body: unknown, keys: string[], errors: string[]): void {
  if (!isPlainObject(body)) {
    errors.push(`${stage} expects an object`);
    return;
  }
  for (const k of keys) if (!(k in body)) errors.push(`${stage} requires "${k}"`);
}

/** Validates one stage body for a given operator. Exported for tests. */
export function validateStage(
  operator: string,
  body: unknown,
  index: number,
  total: number,
  errors: string[],
  warnings: string[],
): void {
  const label = `Stage ${index + 1} (${operator})`;
  if (!KNOWN_STAGES.has(operator)) {
    errors.push(`${label}: unknown stage operator`);
    return;
  }
  switch (operator) {
    case '$match':
    case '$project':
    case '$addFields':
    case '$set':
    case '$sort':
      if (!isPlainObject(body)) errors.push(`${label}: expects an object`);
      else if (operator === '$sort') {
        if (Object.keys(body).length === 0) errors.push(`${label}: needs at least one field`);
        for (const [f, d] of Object.entries(body)) {
          if (d !== 1 && d !== -1 && !(isPlainObject(d) && '$meta' in d))
            errors.push(`${label}: "${f}" must be 1 or -1`);
        }
      } else if (operator === '$project' && Object.keys(body).length === 0)
        errors.push(`${label}: needs at least one field`);
      break;
    case '$limit':
      if (typeof body !== 'number' || !Number.isInteger(body) || body <= 0)
        errors.push(`${label}: must be a positive integer`);
      break;
    case '$skip':
      if (typeof body !== 'number' || !Number.isInteger(body) || body < 0)
        errors.push(`${label}: must be a non-negative integer`);
      break;
    case '$count':
      if (typeof body !== 'string' || body === '' || body.startsWith('$') || body.includes('.')) {
        errors.push(`${label}: must be a field name string, e.g. "total"`);
      }
      break;
    case '$group':
      requireKeys(label, body, ['_id'], errors);
      break;
    case '$lookup':
      if (isPlainObject(body)) {
        if (!('as' in body)) errors.push(`${label}: requires "as"`);
        if (!('from' in body) && !('pipeline' in body))
          errors.push(`${label}: requires "from" (or "pipeline")`);
        if ('localField' in body !== 'foreignField' in body)
          errors.push(`${label}: localField and foreignField go together`);
      } else errors.push(`${label}: expects an object`);
      break;
    case '$unwind':
      if (typeof body === 'string') {
        if (!body.startsWith('$')) errors.push(`${label}: path must start with "$"`);
      } else if (isPlainObject(body)) {
        if (typeof body.path !== 'string' || !body.path.startsWith('$'))
          errors.push(`${label}: "path" must start with "$"`);
      } else errors.push(`${label}: expects "$field" or { path: "$field" }`);
      break;
    case '$facet':
      if (!isPlainObject(body) || Object.keys(body).length === 0)
        errors.push(`${label}: expects { name: [stages] }`);
      else {
        for (const [name, sub] of Object.entries(body)) {
          if (!Array.isArray(sub)) {
            errors.push(`${label}: facet "${name}" must be an array of stages`);
            continue;
          }
          sub.forEach((s, i) => {
            const keys = isPlainObject(s) ? Object.keys(s) : [];
            if (keys.length !== 1)
              errors.push(`${label}: facet "${name}" stage ${i + 1} must have exactly one operator`);
            else if (['$out', '$merge', '$facet'].includes(keys[0] as string)) {
              errors.push(`${label}: ${keys[0]} is not allowed inside $facet`);
            }
          });
        }
      }
      break;
    case '$bucket':
      requireKeys(label, body, ['groupBy', 'boundaries'], errors);
      if (isPlainObject(body) && 'boundaries' in body) {
        const b = body.boundaries;
        if (!Array.isArray(b) || b.length < 2)
          errors.push(`${label}: boundaries must be an array of at least two values`);
      }
      break;
    case '$bucketAuto':
      requireKeys(label, body, ['groupBy', 'buckets'], errors);
      break;
    case '$replaceRoot':
      requireKeys(label, body, ['newRoot'], errors);
      break;
    case '$sample':
      requireKeys(label, body, ['size'], errors);
      break;
    case '$out':
    case '$merge':
      if (index !== total - 1) errors.push(`${label}: must be the last stage`);
      warnings.push(
        `${operator} writes the results into a collection (requires write access and confirmation).`,
      );
      break;
  }
}

export function validatePipeline(stages: PipelineStageInput[]): PipelineValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const pipeline: Document[] = [];
  const active = stages.filter((s) => s.enabled !== false);
  active.forEach((stage, index) => {
    const operator = stage.operator.trim();
    if (!operator.startsWith('$')) {
      errors.push(`Stage ${index + 1}: operator must start with "$"`);
      return;
    }
    let body: unknown;
    try {
      body = parseMongoValue(stage.body.trim() || '{}');
    } catch (error) {
      errors.push(`Stage ${index + 1} (${operator}): ${(error as Error).message}`);
      return;
    }
    validateStage(operator, body, index, active.length, errors, warnings);
    pipeline.push({ [operator]: body });
  });
  const writesData = pipeline.some((s) => WRITE_STAGES.has(Object.keys(s)[0] ?? ''));
  if (
    pipeline.length > 0 &&
    !pipeline.some((s) => '$match' in s || '$limit' in s || '$sample' in s || '$search' in s)
  ) {
    warnings.push('The pipeline has no $match/$limit and may scan the whole collection.');
  }
  return { pipeline, errors, warnings, writesData };
}

/** Parses a raw JSON pipeline (array of stages) into builder stages. */
export function pipelineToStages(pipeline: unknown): PipelineStageInput[] {
  if (!Array.isArray(pipeline)) throw new ValidationError('Pipeline must be an array of stages');
  return pipeline.map((stage, i) => {
    if (!isPlainObject(stage) || Object.keys(stage).length !== 1) {
      throw new ValidationError(`Stage ${i + 1} must be an object with exactly one operator`);
    }
    const [operator, body] = Object.entries(stage)[0] as [string, unknown];
    return { operator, body: EJSON.stringify(body, undefined, 2, { relaxed: true }), enabled: true };
  });
}

export interface AggregationOptions {
  resultLimit: number;
  timeoutMs: number;
  allowDiskUse: boolean;
}

export interface AggregationResult {
  documents: Document[];
  durationMs: number;
  returned: number;
  truncated: boolean;
  wroteData: boolean;
}

export class AggregationManager {
  constructor(
    private readonly client: MongoClient,
    private readonly permissions: PermissionManager,
  ) {}

  /**
   * Runs a validated pipeline. A trailing $limit (resultLimit+1) is appended for read pipelines so
   * the server stops early; results are additionally capped client-side and the cursor closed.
   */
  async run(
    database: string,
    collection: string,
    pipeline: Document[],
    options: AggregationOptions,
    signal?: AbortSignal,
  ): Promise<AggregationResult> {
    const writes = pipeline.some((s) => WRITE_STAGES.has(Object.keys(s)[0] ?? ''));
    if (writes) this.permissions.assert(Operations.aggregationWrite);
    const bounded = writes ? pipeline : [...pipeline, { $limit: options.resultLimit + 1 }];
    const started = process.hrtime.bigint();
    const cursor = this.client
      .db(database)
      .collection(collection)
      .aggregate(bounded, {
        maxTimeMS: options.timeoutMs,
        allowDiskUse: options.allowDiskUse,
        batchSize: Math.min(options.resultLimit + 1, 1000),
      });
    const { documents } = await takeFromCursor(cursor, options.resultLimit + 1, signal);
    const truncated = documents.length > options.resultLimit;
    const docs = truncated ? documents.slice(0, options.resultLimit) : documents;
    return {
      documents: docs,
      durationMs: elapsed(started),
      returned: docs.length,
      truncated,
      wroteData: writes,
    };
  }

  async explain(
    database: string,
    collection: string,
    pipeline: Document[],
    timeoutMs: number,
  ): Promise<Document> {
    return this.client
      .db(database)
      .collection(collection)
      .aggregate(pipeline, { maxTimeMS: timeoutMs })
      .explain('queryPlanner');
  }
}
