import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { PluginConfig } from './types.js';

/** Volatile references are structural so ordinary configs remain usable by embedders/tests. */
export type SettingsConfig = {
  [K in keyof PluginConfig]: Readonly<PluginConfig[K]> | { get(): Readonly<PluginConfig[K]> };
};

function unwrap<T>(value: T | { get(): T }): T {
  if (
    value !== null &&
    typeof value === 'object' &&
    'get' in value &&
    typeof value.get === 'function'
  )
    return value.get();
  return value as T;
}

function nonempty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes('\0'))
    throw new Schema.ValidationError(`${field} must be nonempty and contain no NUL.`, {
      path: [field],
    });
  return normalized;
}

function absolute(value: string, field: string): string {
  if (!isAbsolute(value) || value.includes('\0'))
    throw new Schema.ValidationError(`${field} must be an absolute path without NUL.`, {
      path: [field],
    });
  return value;
}

function normalizedIds(values: string[], field: string, allowAll = true): string[] {
  const ids = [...new Set(values.map((id) => nonempty(id, field)))];
  if (ids.some((id) => /[\s\u0000-\u001f\u007f]/.test(id)))
    throw new Schema.ValidationError(`${field}: invalid conversation ID.`, { path: [field] });
  if (ids.includes('all') && (!allowAll || ids.length !== 1))
    throw new Schema.ValidationError(
      allowAll
        ? `${field}: all must be used alone.`
        : `${field}: use an empty list to allow every caller.`,
      { path: [field] },
    );
  return ids;
}

// Only data-only schemas cross the settings/configForms boundary: serialized
// transform callbacks cannot retain Node imports or their lexical closures.
const nonblank = Schema.string().pattern(/^(?=[\s\S]*\S)[^\0]+$/);
const selection = () => Schema.array(nonblank.required()).default([]).volatile();
const absolutePath = Schema.string()
  .min(1)
  .pattern(process.platform === 'win32' ? /^(?:[a-zA-Z]:[\\/]|[\\/])/ : /^\//);

const fields = Schema.object({
  nodePath: nonblank
    .default('node')
    .volatile()
    .description('Independent Node >=22 executable capable of loading LanceDB.'),
  dataPath: absolutePath
    .default(join(homedir(), '.dsh', 'chat-recall'))
    .volatile()
    .description('Absolute derived-index directory; one plugin instance per directory.'),
  sessionIds: selection().description(
    'Sessions to index; ["all"] includes all main conversations, including archived and user forks.',
  ),
  embeddingSessionIds: selection().description(
    'Sessions explicitly allowed to send text to the embedding service; ["all"] covers the configured text corpus.',
  ),
  envFile: absolutePath
    .volatile()
    .description(
      'Absolute local env-file with OpenAI-compatible credentials. Read only by the worker.',
    ),
  callerSessionIds: selection().description(
    'Optional caller session allowlist; empty exposes tools to this profile.',
  ),
  autoSync: Schema.boolean()
    .default(true)
    .volatile()
    .description(
      'Backfill configured sessions and process committed event tails in the background.',
    ),
  dominantMin: Schema.number()
    .min(0)
    .max(1)
    .default(0.5)
    .volatile()
    .description(
      'Minimum top cosine similarity for single-candidate display; heuristic, not a confidence threshold.',
    ),
  dominantGap: Schema.number()
    .min(0)
    .max(2)
    .default(0.15)
    .volatile()
    .description('Required top1 minus top2 cosine gap for single-candidate display.'),
});

function values(config: SettingsConfig): PluginConfig {
  const envFile = unwrap(config.envFile);
  return {
    nodePath: unwrap(config.nodePath),
    dataPath: unwrap(config.dataPath),
    sessionIds: [...unwrap(config.sessionIds)],
    embeddingSessionIds: [...unwrap(config.embeddingSessionIds)],
    ...(envFile == null ? {} : { envFile }),
    callerSessionIds: [...unwrap(config.callerSessionIds)],
    autoSync: unwrap(config.autoSync),
    dominantMin: unwrap(config.dominantMin),
    dominantGap: unwrap(config.dominantGap),
  };
}

function validateEmbedding(config: SettingsConfig): void {
  const { sessionIds: corpus, embeddingSessionIds: embedding } = values(config);
  if (
    embedding.length &&
    (!corpus.length ||
      (!embedding.includes('all') &&
        !corpus.includes('all') &&
        embedding.some((id) => !corpus.includes(id))))
  )
    throw new Schema.ValidationError(
      'embeddingSessionIds must be within a nonempty configured corpus.',
      {
        path: ['embeddingSessionIds'],
      },
    );
}

function parse(input?: Parameters<typeof fields>[0], options?: Schemastery.Options) {
  // First validate primitive types/defaults, then normalize a detached snapshot.
  // The second parse creates immutable refs containing only normalized values.
  const config = values(fields(input, options));
  config.nodePath = nonempty(config.nodePath, 'nodePath');
  config.dataPath = absolute(config.dataPath, 'dataPath');
  if (config.envFile !== undefined) config.envFile = absolute(config.envFile, 'envFile');
  config.sessionIds = normalizedIds(config.sessionIds, 'sessionIds');
  config.embeddingSessionIds = normalizedIds(config.embeddingSessionIds, 'embeddingSessionIds');
  config.callerSessionIds = normalizedIds(config.callerSessionIds, 'callerSessionIds', false);
  validateEmbedding(config);
  return fields({ ...input, ...config }, options);
}

// A root transform/intersection makes volatile children invalid (non-fixed paths).
// Keep the actual object schema and its projection/simplify metadata intact while
// applying the cross-field check to both direct calls and Cordis standard validation.
export const Config = new Proxy(fields, {
  apply(_target, _receiver, args: Parameters<typeof fields>) {
    return parse(...args);
  },
  get(target, key, receiver) {
    if (key === '~standard')
      return {
        version: 1,
        vendor: 'schemastery',
        validate(input: Parameters<typeof fields>[0]) {
          try {
            return { value: parse(input) };
          } catch (error) {
            if (Schema.ValidationError.is(error))
              return { issues: [{ message: error.message, path: error.options.path }] };
            throw error;
          }
        },
      };
    return Reflect.get(target, key, receiver);
  },
});

/** Copy committed refs into one validated, independent runtime generation. */
export function snapshotConfig(config: SettingsConfig): PluginConfig {
  return values(Config(values(config)));
}
