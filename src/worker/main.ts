import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { createEmbedder } from '../embedding/client.js';
import { openStore } from '../storage/store.js';
import type { RecallStore } from '../storage/store.js';
import type { WorkerRequest } from '../shared/protocol.js';
import { errorCode } from '../shared/model.js';

const root = resolve(process.argv[2]);
let store: RecallStore | undefined;
const send = (value: unknown): Promise<void> =>
  new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(value) + '\n', (error) =>
      error ? reject(error) : resolve(),
    );
  });
const errors = new Set([
  'INVALID_REQUEST',
  'NOT_FOUND',
  'NOT_PREPARED',
  'SOURCE_CHANGED',
  'SYNC_INCOMPLETE',
  'EMBEDDING_NOT_READY',
  'EMBEDDING_CONFIG_CHANGED',
  'NO_EMBEDDING_CONFIG',
  'INVALID_RESPONSE',
  'CURSOR_EXPIRED',
  'INVALID_CURSOR',
  'SEARCH_CAPACITY',
  'WORKER_ERROR',
  'NETWORK_ERROR',
  'HTTP_ERROR',
  'TIMEOUT',
  'ABORTED',
]);
function embedding() {
  if (!process.env.OPENAI_API_KEY?.trim()) return undefined;
  return createEmbedder({
    apiKey: process.env.OPENAI_API_KEY.trim(),
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    ...(process.env.OPENAI_EMBEDDING_DIMENSIONS
      ? { dimensions: Number(process.env.OPENAI_EMBEDDING_DIMENSIONS) }
      : {}),
  });
}

await send({
  type: 'ready',
  protocol: 1,
  pid: process.pid,
  node: process.version,
  lancedb: '0.41.0',
});
try {
  // Serialize every store operation; the JSONL bridge has no implicit replay.
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let request: WorkerRequest | undefined;
    try {
      request = JSON.parse(line) as WorkerRequest;
      let value: unknown;
      if (request.method === 'configure') {
        if (store) throw Object.assign(new Error('Configured'), { code: 'INVALID_REQUEST' });
        const params: Partial<Extract<WorkerRequest, { method: 'configure' }>['params']> =
          request.params ?? {};
        store = await openStore({
          root,
          embedder: params.embeddingEnabled ? embedding() : undefined,
          candidatePolicy: params.candidatePolicy,
        });
        value = { configured: true };
      } else {
        if (!store) throw Object.assign(new Error('Not configured'), { code: 'NOT_PREPARED' });
        switch (request.method) {
          case 'sync':
            value = await store.sync(request.params ?? {});
            break;
          case 'checkpoints':
            value = await store.checkpoints(request.params ?? {});
            break;
          case 'embed':
            value = await store.embed(request.params ?? {});
            break;
          case 'search':
            value = await store.search(request.params ?? {});
            break;
          case 'read':
            value = await store.read(request.params ?? {});
            break;
          case 'sessions':
            value = await store.sessions(request.params ?? {});
            break;
          case 'status':
            value = await store.status();
            break;
          default:
            throw Object.assign(new Error('Unknown method'), { code: 'INVALID_REQUEST' });
        }
      }
      await send({ id: request.id, ok: true, value });
    } catch (error) {
      const code = errorCode(error, 'WORKER_ERROR');
      await send({
        id: request?.id ?? null,
        ok: false,
        error: {
          code: errors.has(code) ? code : 'WORKER_ERROR',
          message: 'Chat recall operation failed.',
        },
      });
    }
  }
} finally {
  await store?.close();
}
