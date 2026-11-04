import { createHash } from 'node:crypto';
import type { Embedder } from '../shared/model.js';
import { timed, timedSync } from '../shared/timing.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MESSAGES = {
  NETWORK_ERROR: 'Embedding request failed.',
  HTTP_ERROR: 'Embedding endpoint rejected the request.',
  INVALID_RESPONSE: 'Embedding endpoint returned an invalid response.',
  ABORTED: 'Embedding request was cancelled.',
  TIMEOUT: 'Embedding request timed out.',
};

/** Vector-space configuration; credentials and batching do not define the space. */
export interface EmbedderOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  dimensions?: number;
  batchSize?: number;
}

export interface FetchRequest {
  method: 'POST';
  headers: { Authorization: string; 'Content-Type': string };
  body: string;
  signal: AbortSignal;
  redirect: 'error';
}

/** The transport contract deliberately supports minimal local test mocks. */
export interface FetchResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: FetchRequest) => Promise<FetchResponse> | FetchResponse;

export interface EmbedderDependencies {
  fetchImpl?: FetchLike;
}

export type CreateEmbedderResult = Embedder;
export type EmbeddingErrorCode = keyof typeof MESSAGES;

export interface EmbeddingError extends Error {
  code: EmbeddingErrorCode;
}

interface ResponsePayload {
  data?: unknown;
}

interface ResponseItem {
  index?: number;
  embedding?: unknown;
}

interface OrderedVectors {
  vectors: number[][];
  dimensions: number | undefined;
}

function failure(code: EmbeddingErrorCode): EmbeddingError {
  const error = new Error(MESSAGES[code]) as EmbeddingError;
  error.code = code;
  if (code === 'ABORTED') error.name = 'AbortError';
  if (code === 'TIMEOUT') error.name = 'TimeoutError';
  return error;
}

function endpointFor(baseURL: string): string {
  if (typeof baseURL !== 'string' || !baseURL.trim()) {
    throw new TypeError('baseURL must be an absolute HTTP(S) URL.');
  }
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new TypeError('baseURL must be an absolute HTTP(S) URL.');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError('baseURL must use HTTP(S), without credentials, a query, or a fragment.');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/embeddings`;
  return url.href;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

/** Validate untrusted JSON before a batch can establish the inferred dimension. */
function orderedVectors(
  payload: unknown,
  count: number,
  expectedDimensions: number | undefined,
): OrderedVectors {
  const response = payload as ResponsePayload | null | undefined;
  if (!response || !Array.isArray(response.data) || response.data.length !== count) {
    throw failure('INVALID_RESPONSE');
  }
  const vectors: number[][] = new Array(count);
  let dimensions = expectedDimensions;
  for (const entry of response.data as unknown[]) {
    const item = entry as ResponseItem | null | undefined;
    if (
      !item ||
      !Number.isSafeInteger(item.index) ||
      item.index! < 0 ||
      item.index! >= count ||
      vectors[item.index!] !== undefined
    ) {
      throw failure('INVALID_RESPONSE');
    }
    const vector = item.embedding;
    if (!Array.isArray(vector) || vector.length === 0) throw failure('INVALID_RESPONSE');
    dimensions ??= vector.length;
    if (vector.length !== dimensions) throw failure('INVALID_RESPONSE');
    for (const value of vector as unknown[]) {
      if (!Number.isFinite(value)) throw failure('INVALID_RESPONSE');
    }
    vectors[item.index!] = [...(vector as number[])];
  }
  return { vectors, dimensions };
}

/** Create a sequential, abortable embedding client without retaining secrets in errors. */
export function createEmbedder(
  { baseURL, apiKey, model, dimensions, batchSize = 64 }: EmbedderOptions,
  { fetchImpl = fetch }: EmbedderDependencies = {},
): CreateEmbedderResult {
  const endpoint = endpointFor(baseURL);
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\u0000-\u001f\u007f]/.test(apiKey)) {
    throw new TypeError('apiKey must be a nonempty string without control characters.');
  }
  if (typeof model !== 'string' || !model.trim())
    throw new TypeError('model must be a nonempty string.');
  if (dimensions !== undefined) positiveInteger(dimensions, 'dimensions');
  positiveInteger(batchSize, 'batchSize');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');

  // Credentials and transport batching do not define a vector space.
  const spaceId = `openai-embedding:v1:${createHash('sha256')
    .update(JSON.stringify([endpoint, model, dimensions ?? null, 'float']))
    .digest('hex')}`;
  let expectedDimensions = dimensions;

  async function requestBatch(input: string[], signal?: AbortSignal): Promise<number[][]> {
    if (signal?.aborted) throw failure('ABORTED');
    const controller = new AbortController();
    let timedOut = false;
    let onRequestAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      onRequestAbort = () => reject(failure(timedOut ? 'TIMEOUT' : 'ABORTED'));
      controller.signal.addEventListener('abort', onRequestAbort, { once: true });
    });
    // Do not forward the caller's abort reason, which may contain credentials.
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    async function fetchJSON(): Promise<unknown> {
      let code: EmbeddingErrorCode = 'NETWORK_ERROR';
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            input,
            encoding_format: 'float',
            ...(dimensions !== undefined ? { dimensions } : {}),
          }),
          signal: controller.signal,
          redirect: 'error',
        });
        if (controller.signal.aborted) throw failure('ABORTED');
        code = 'INVALID_RESPONSE';
        if (!response || response.ok !== true) {
          code = 'HTTP_ERROR';
          throw failure(code);
        }
        return await response.json();
      } catch {
        // Never retain a fetch/JSON error, response body, request, or cause.
        throw failure(code);
      }
    }

    let completed = false;
    try {
      // The race also bounds mocks/transports that ignore AbortSignal.
      const payload = await timed('embedding.http', () => Promise.race([fetchJSON(), cancelled]));
      if (controller.signal.aborted) throw failure(timedOut ? 'TIMEOUT' : 'ABORTED');
      let result: OrderedVectors;
      try {
        result = timedSync('embedding.validate', () =>
          orderedVectors(payload, input.length, expectedDimensions),
        );
      } catch {
        throw failure('INVALID_RESPONSE');
      }
      // Only a fully validated batch can establish the inferred dimension.
      expectedDimensions = result.dimensions;
      completed = true;
      return result.vectors;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      controller.signal.removeEventListener('abort', onRequestAbort);
      // Cancel unread error bodies without exposing or retaining their contents.
      if (!completed) controller.abort();
    }
  }

  async function embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!Array.isArray(texts)) throw new TypeError('texts must be an array of strings.');
    const input = [...texts];
    for (const text of input) {
      if (typeof text !== 'string')
        throw new TypeError('texts must contain only primitive strings.');
    }
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new TypeError('signal must be an AbortSignal.');
    }
    if (input.length === 0) return [];
    const vectors: number[][] = [];
    for (let offset = 0; offset < input.length; offset += batchSize) {
      const batch = await requestBatch(input.slice(offset, offset + batchSize), signal);
      for (const vector of batch) vectors.push(vector);
    }
    return vectors;
  }

  return { spaceId, embed };
}
