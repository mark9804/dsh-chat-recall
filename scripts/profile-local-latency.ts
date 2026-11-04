import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OpenStoreOptions, RecallStore } from '../src/storage/store.js';

// Offline-only: import the installed implementation into a private instrumented
// copy. No environment file, fetch, model client, profile mutation or cleanup.
const installed = resolve(
  process.argv[2] ?? '/Users/zhaoluchen/.dsh/profiles/desktop/node_modules/dsh-chat-recall',
);
const corpusRoot = resolve(process.argv[3] ?? '.benchmark/qwen-vllm');
const output = resolve(
  process.argv[4] ?? `.benchmark/latency-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`,
);
const dist = join(installed, 'dist');
const originalStore = await readFile(join(dist, 'storage/store.js'), 'utf8');
const variant = process.argv[5] ?? 'production';
if (!['production', 'bulk-progress'].includes(variant))
  throw new Error('Unknown profiling variant.');
const originalCursors = await readFile(join(dist, 'core/cursors.js'), 'utf8');
const packageVersion = (
  JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as { version: string }
).version;
const cached = JSON.parse(
  await readFile(join(corpusRoot, 'materialization-query-vectors.json'), 'utf8'),
) as { spaceId: string; queries: { id: string; query: string; vector: number[] }[] };
if (cached.queries.length !== 8 || cached.queries.some((row) => row.vector.length !== 2048))
  throw new Error('Expected the existing eight authorized cached Qwen query vectors.');
const identity = JSON.parse(await readFile(join(corpusRoot, 'run-identity.json'), 'utf8')) as {
  spaceId: string;
};
if (identity.spaceId !== cached.spaceId) throw new Error('Cache and source space differ.');
await mkdir(join(output, 'modules'), { recursive: true, mode: 0o700 });
interface Event {
  name: string;
  ms: number;
  phase: string;
  count?: number;
}
interface ProfileModule {
  openStore: (options: OpenStoreOptions) => Promise<RecallStore>;
  __events: Event[];
}
const header = `\nexport const __events = [];\nlet __phase = 'startup';\nfunction __record(name, start, count) { __events.push({name, ms:performance.now()-start, phase:__phase, ...(count===undefined?{}:{count})}); }\nasync function __timed(name, fn) { const t=performance.now();try{return await fn();}finally{__record(name,t);} }\n`;
function once(source: string, from: string, to: string): string {
  const pieces = source.split(from);
  if (pieces.length !== 2)
    throw new Error(`Instrumentation anchor is not unique: ${from.slice(0, 80)}`);
  return pieces[0] + to + pieces[1];
}
function absoluteImports(source: string, file: string, cursors: string): string {
  return source.replace(/from '([^']+)'/g, (statement: string, specifier: string) => {
    if (!specifier.startsWith('.')) return statement;
    const target =
      specifier === '../core/cursors.js'
        ? cursors
        : pathToFileURL(resolve(dirname(file), specifier)).href;
    return `from '${target}'`;
  });
}
let cursors = originalCursors;
cursors = once(cursors, '    async create({', '    async __profileCreate({');
// Wrap only public create; next-page logic and immutable snapshots stay untouched.
cursors = once(
  cursors,
  '    async __profileCreate({',
  `    async create(options) { const t=performance.now();try{return await this.__profileCreate(options);}finally{globalThis.__recallLatencySnapshotMs?.(performance.now()-t);} }\n    async __profileCreate({`,
);
const cursorFile = join(output, 'modules/cursors.js');
await writeFile(cursorFile, cursors, { mode: 0o600 });
let source = header + originalStore;
source = once(
  source,
  'return (await query.toArray()).map(plain);',
  `const nativeStart=performance.now();const rows=await query.toArray();__record(('where' in query?'db.toArray':'arrow.batch-toArray'),nativeStart,rows.length);const arrowStart=performance.now();const plainRows=rows.map(plain);__record('arrow.plain',arrowStart,rows.length);return plainRows;`,
);
source = once(
  source,
  'const blockCount = await blocks.countRows(scopeWhere(params));',
  `__phase='scope';const blockCount=await __timed('scope.block-count',()=>blocks.countRows(scopeWhere(params)));`,
);
source = once(
  source,
  'const scopeChunks = await vectors.countRows(where);',
  `const scopeChunks=await __timed('scope.chunk-count',()=>vectors.countRows(where));`,
);
source = once(
  source,
  'const result = await configured.embed([params.query]);',
  `const result=await __timed('query.cached-vector',()=>configured.embed([params.query]));`,
);
source = once(
  source,
  '        if (!flat) {',
  `        __phase='index';const __indexStart=performance.now();\n        if (!flat) {`,
);
source = once(
  source,
  '        let selected;',
  `        __record('index.ready',__indexStart);__phase='vector-fetch';const __fetchStart=performance.now();\n        let selected;`,
);
source = once(
  source,
  '        const best = new Map();',
  `        __record('vector.fetch',__fetchStart,selected.length);__phase='rerank';const __rerankStart=performance.now();\n        const best = new Map();`,
);
source = once(
  source,
  '        const hits = [];\n        // Materialize only ranked candidates',
  `        __record('vector.rerank-dedup-sort',__rerankStart,ranked.length);__phase='candidate-lookup';const __lookupStart=performance.now();\n        const hits = [];\n        // Materialize only ranked candidates`,
);
source = once(
  source,
  '        for (const row of candidates) {',
  `        __record('candidate.blocks-lookup',__lookupStart,candidateBlocks.size);__phase='excerpts';const __excerptStart=performance.now();\n        for (const row of candidates) {`,
);
source = once(
  source,
  '        const pending = (await pendingRows(params.sessionIds, undefined, scopeWhere(params))).pending;',
  `        __record('candidate.excerpts',__excerptStart,hits.length);__phase='pending-progress';const __pendingStart=performance.now();const pending=(await pendingRows(params.sessionIds,undefined,scopeWhere(params))).pending;__record('coverage.pending-scan',__pendingStart);__phase='presentation';`,
);
if (variant === 'bulk-progress') {
  // Diagnostic eager metadata join (not a production memory policy): keep the
  // source metadata stream, fetch progress once per128 sessions instead of per128
  // source blocks. This holds scoped progress in memory; measure before adopting.
  source = once(
    source,
    '        let pending = 0, completedChunks = 0;\n        for await (const arrowBatch of query) {',
    `        const doneRows = new Map();
        for (let offset=0;offset<sessionIds.length;offset+=128) {
          const rows = await rowsOf(progress.query().where(inList('sessionId',sessionIds.slice(offset,offset+128))));
          for(const row of rows)doneRows.set(row.id,row);
        }
        let pending = 0, completedChunks = 0;
        for await (const arrowBatch of query) {`,
  );
  source = once(
    source,
    "                const completed = await lookup(progress, 'id', group.map(progressId));",
    '                const completed = doneRows;',
  );
}
source = absoluteImports(source, join(dist, 'storage/store.js'), pathToFileURL(cursorFile).href);
const storeFile = join(output, 'modules/store.js');
await writeFile(storeFile, source, { mode: 0o600 });
const instrumented = (await import(pathToFileURL(storeFile).href)) as ProfileModule;
const snapshots: number[] = [];
Reflect.set(globalThis, '__recallLatencySnapshotMs', (ms: number) => snapshots.push(ms));
const cache = new Map(cached.queries.map((row) => [row.query, row.vector]));
let cacheCalls = 0;
const embedder = {
  spaceId: cached.spaceId,
  async embed(texts: string[]) {
    cacheCalls++;
    return texts.map((text) => {
      const value = cache.get(text);
      if (!value) throw new Error('Offline profiling cannot create new query vectors.');
      return value;
    });
  },
};
const openStart = performance.now();
const store = await instrumented.openStore({ root: join(corpusRoot, 'index'), embedder });
const openMs = performance.now() - openStart;
const results: {
  id: string;
  repetition: number;
  totalMs: number;
  nextMs: number;
  snapshotMs: number | null;
  returned: number;
  totalCandidates: number;
  continued: number;
  pendingBlocks: number | null;
  events: Event[];
  top20: { ref: string; score: number | undefined }[];
}[] = [];
try {
  for (let repetition = 0; repetition < 3; repetition++) {
    for (const q of cached.queries) {
      instrumented.__events.length = 0;
      snapshots.length = 0;
      const request = {
        query: q.query,
        mode: 'semantic',
        sessionIds: ['evaluation-source-0', 'evaluation-source-1'],
        binding: 'offline-stage-profile',
        limit: 20,
      };
      const start = performance.now();
      const page = await store.search(request);
      const totalMs = performance.now() - start;
      const nextStart = performance.now();
      const next = page.nextCursor
        ? await store.search({ ...request, cursor: page.nextCursor })
        : null;
      const nextMs = performance.now() - nextStart;
      results.push({
        id: q.id,
        repetition,
        totalMs,
        nextMs,
        snapshotMs: snapshots[0] ?? null,
        returned: page.hits.length,
        totalCandidates: page.totalCandidates,
        continued: next?.hits.length ?? 0,
        pendingBlocks: page.coverage.pendingBlocks ?? null,
        events: [...instrumented.__events],
        top20: page.hits.map((hit) => ({ ref: hit.ref, score: hit.similarity })),
      });
    }
  }
} finally {
  await store.close();
  Reflect.deleteProperty(globalThis, '__recallLatencySnapshotMs');
}
const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
};
const stages = [
  'scope.block-count',
  'scope.chunk-count',
  'query.cached-vector',
  'index.ready',
  'vector.fetch',
  'vector.rerank-dedup-sort',
  'candidate.blocks-lookup',
  'candidate.excerpts',
  'coverage.pending-scan',
];
const summary = {
  at: new Date().toISOString(),
  version: packageVersion,
  variant,
  implementationSha256: createHash('sha256').update(originalStore).digest('hex'),
  queries: cached.queries.length,
  repetitions: 3,
  indexExisting: true,
  cachedVectorCalls: cacheCalls,
  networkRequests: 0,
  openMs,
  totalMs: {
    p50: percentile(
      results.map((row) => row.totalMs),
      0.5,
    ),
    p95: percentile(
      results.map((row) => row.totalMs),
      0.95,
    ),
  },
  stageMs: Object.fromEntries(
    stages.map((name) => [
      name,
      {
        p50: percentile(
          results.map((row) =>
            row.events.filter((e) => e.name === name).reduce((n, e) => n + e.ms, 0),
          ),
          0.5,
        ),
        p95: percentile(
          results.map((row) =>
            row.events.filter((e) => e.name === name).reduce((n, e) => n + e.ms, 0),
          ),
          0.95,
        ),
      },
    ]),
  ),
  snapshotMs: {
    p50: percentile(
      results.map((row) => row.snapshotMs ?? 0),
      0.5,
    ),
    p95: percentile(
      results.map((row) => row.snapshotMs ?? 0),
      0.95,
    ),
  },
  nextMs: {
    p50: percentile(
      results.map((row) => row.nextMs),
      0.5,
    ),
    p95: percentile(
      results.map((row) => row.nextMs),
      0.95,
    ),
  },
  nativeCallsByPhase: Object.fromEntries(
    ['vector-fetch', 'candidate-lookup', 'pending-progress'].map((phase) => [
      phase,
      {
        queriesPerSearch: results[0].events.filter(
          (e) => e.phase === phase && e.name === 'db.toArray',
        ).length,
        nativeMsP50: percentile(
          results.map((row) =>
            row.events
              .filter((e) => e.phase === phase && e.name === 'db.toArray')
              .reduce((n, e) => n + e.ms, 0),
          ),
          0.5,
        ),
        arrowMsP50: percentile(
          results.map((row) =>
            row.events
              .filter((e) => e.phase === phase && e.name === 'arrow.plain')
              .reduce((n, e) => n + e.ms, 0),
          ),
          0.5,
        ),
      },
    ]),
  ),
  limits: [
    'Installed implementation instrumented in private copy; no installed/source/profile modifications.',
    'Local cached-vector store search only; no HTTP, DSH host sync, worker queue or agent read-source verification.',
    'All phases serial; per-phase medians do not necessarily sum to overall median.',
    'Existing IVF index and filesystem cache; first-process open measured separately.',
    'No baseline corpus or index files were removed or reset; only ordinary immutable search snapshots appended.',
  ],
};
await writeFile(
  join(output, 'results.json'),
  JSON.stringify({ summary, results }, null, 2) + '\n',
  { mode: 0o600 },
);
console.log(JSON.stringify({ output, ...summary }, null, 2));
