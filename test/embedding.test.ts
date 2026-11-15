import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { inspect } from 'node:util';
import { test } from 'node:test';
import {
  createEmbedder,
  type EmbedderOptions,
  type EmbeddingErrorCode,
  type FetchLike,
  type FetchResponse,
} from '../dist/embedding/client.js';

const SECRET = 'sk-test-only-credential-DO-NOT-LEAK';
const config = { baseURL: 'https://example.invalid/v1', apiKey: SECRET, model: 'test-embedding' };
const response = (data: unknown): FetchResponse => ({ ok: true, json: async () => ({ data }) });
const item = (index: unknown, embedding: unknown = [1, 2]) => ({ index, embedding });
const unusedFetch = () => assert.fail('fetch must not be called');

function safeError(code: EmbeddingErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error);
    assert.equal(error.code, code);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(Object.hasOwn(error, 'response'), false);
    assert.equal(Object.hasOwn(error, 'request'), false);
    assert.equal(inspect(error, { depth: 10 }).includes(SECRET), false);
    assert.equal(JSON.stringify(error).includes(SECRET), false);
    return true;
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('POSTs the embedding protocol and reorders rows by data.index', async () => {
  let calls = 0;
  const embedder = createEmbedder(
    { ...config, baseURL: 'https://example.invalid/v1///', dimensions: 2 },
    {
      fetchImpl: async (url, init) => {
        calls++;
        assert.equal(url, 'https://example.invalid/v1/embeddings');
        assert.equal(init.method, 'POST');
        assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
        assert.equal(init.headers['Content-Type'], 'application/json');
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal(init.signal.aborted, false);
        assert.deepEqual(JSON.parse(init.body), {
          model: config.model,
          input: ['first', 'second'],
          encoding_format: 'float',
          dimensions: 2,
        });
        return response([item(1, [3, 4]), item(0, [1, 2])]);
      },
    },
  );
  assert.deepEqual(await embedder.embed(['first', 'second']), [
    [1, 2],
    [3, 4],
  ]);
  assert.equal(calls, 1);
});

test('omits dimensions unless explicitly configured and does not coerce strings', async () => {
  const input = [
    '',
    'https://example.invalid/attachment.png',
    'data:image/png;base64,YWJj',
    'YWJj',
  ];
  const embedder = createEmbedder(config, {
    fetchImpl: async (_, init) => {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.input, input);
      assert.equal(Object.hasOwn(body, 'dimensions'), false);
      return response(input.map((_, index) => item(index)));
    },
  });
  assert.equal((await embedder.embed(input)).length, input.length);
});

test('batches sequentially, preserves global ordering, and snapshots the input', async () => {
  const inputs: string[][] = [];
  const original = ['0', '1', '2', '3', '4'];
  let active = 0;
  const embedder = createEmbedder(
    { ...config, batchSize: 2 },
    {
      fetchImpl: async (_, init) => {
        assert.equal(active++, 0);
        const { input } = JSON.parse(init.body) as { input: string[] };
        inputs.push(input);
        original[2] = 'changed';
        await Promise.resolve();
        active--;
        return response(input.map((text, index) => item(index, [Number(text)])).reverse());
      },
    },
  );
  assert.deepEqual(await embedder.embed(original), [[0], [1], [2], [3], [4]]);
  assert.deepEqual(inputs, [['0', '1'], ['2', '3'], ['4']]);
});

test('spaceId is stable, credential-independent, and separated by vector-space settings', async () => {
  const make = (overrides: Partial<EmbedderOptions>) =>
    createEmbedder({ ...config, ...overrides }, { fetchImpl: unusedFetch });
  const base = make({});
  assert.equal(base.spaceId, make({ apiKey: 'another-test-key', batchSize: 1 }).spaceId);
  assert.equal(base.spaceId, make({ baseURL: 'https://EXAMPLE.invalid:443/v1/' }).spaceId);
  assert.equal(base.spaceId, make({ dimensions: undefined }).spaceId);
  assert.notEqual(base.spaceId, make({ baseURL: 'https://other.invalid/v1' }).spaceId);
  assert.notEqual(base.spaceId, make({ model: 'another-model' }).spaceId);
  assert.notEqual(base.spaceId, make({ dimensions: 2 }).spaceId);
  assert.notEqual(make({ dimensions: 2 }).spaceId, make({ dimensions: 3 }).spaceId);
  assert.match(base.spaceId, /^openai-embedding:v1:[a-f0-9]{64}$/);
  assert.equal(base.spaceId.includes(SECRET), false);
  const inferred = createEmbedder(config, { fetchImpl: async () => response([item(0)]) });
  await inferred.embed(['first']);
  await inferred.embed(['second']);
  assert.equal(inferred.spaceId, base.spaceId);
});

test('empty input returns [] without fetch, including with an aborted signal', async () => {
  const embedder = createEmbedder(config, { fetchImpl: unusedFetch });
  assert.deepEqual(await embedder.embed([]), []);
  assert.deepEqual(await embedder.embed([], AbortSignal.abort(SECRET)), []);
});

test('rejects non-text input before any batch is sent', async () => {
  const invalid = [
    null,
    'text',
    new Set(['text']),
    [{ type: 'attachment', url: 'https://example.invalid/a' }],
    [Buffer.from('test')],
    new Array(1),
    ['valid', 1],
  ];
  const embedder = createEmbedder({ ...config, batchSize: 1 }, { fetchImpl: unusedFetch });
  for (const input of invalid)
    await assert.rejects(embedder.embed(input as unknown as string[]), TypeError);
  await assert.rejects(
    createEmbedder(config, { fetchImpl: unusedFetch }).embed(
      ['text'],
      {} as unknown as AbortSignal,
    ),
    TypeError,
  );
});

test('rejects malformed configuration without disclosing credential-like values', () => {
  const invalid = [
    { baseURL: SECRET },
    { baseURL: `ftp://example.invalid/${SECRET}` },
    { baseURL: `https://name:${SECRET}@example.invalid/v1` },
    { baseURL: `https://example.invalid/v1?key=${SECRET}` },
    { baseURL: `https://example.invalid/v1#${SECRET}` },
    { baseURL: null },
    { apiKey: '' },
    { apiKey: '  ' },
    { apiKey: `${SECRET}\n` },
    { apiKey: null },
    { model: '' },
    { model: null },
    { dimensions: 0 },
    { dimensions: -1 },
    { dimensions: 1.5 },
    { dimensions: NaN },
    { dimensions: '2' },
    { dimensions: null },
    { batchSize: 0 },
    { batchSize: Infinity },
    { batchSize: Number.MAX_SAFE_INTEGER + 1 },
    { batchSize: '1' },
  ];
  for (const overrides of invalid) {
    assert.throws(
      () =>
        createEmbedder({ ...config, ...overrides } as unknown as EmbedderOptions, {
          fetchImpl: unusedFetch,
        }),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.equal(inspect(error).includes(SECRET), false);
        return true;
      },
    );
  }
  assert.throws(
    () => createEmbedder(config, { fetchImpl: null as unknown as FetchLike }),
    TypeError,
  );
});

test('rejects incomplete, misindexed or non-finite vector batches without leaking content', async () => {
  const payloads = [
    null,
    {},
    { data: [] },
    { data: [item(0)] },
    { data: [item(0), item(1), item(2)] },
    { data: [null, item(1)] },
    { data: [item(0), item(0)] },
    { data: [item(-1), item(1)] },
    { data: [item(0), item(2)] },
    { data: [item(0), item(0.5)] },
    { data: [item(0), item('1')] },
    { data: [item(0), { embedding: [1, 2] }] },
    { data: [item(0), item(1, [])] },
    { data: [item(0), item(1, 'YWJj')] },
    { data: [item(0), item(1, [1])] },
    { data: [item(0), item(1, [1, NaN])] },
    { data: [item(0), item(1, [1, Infinity])] },
    { data: [item(0), item(1, [1, '2'])] },
    { data: [item(0), item(1, new Array(2))] },
    { data: [item(0), item(1, new Float32Array([1, 2]))] },
    { data: new Array(2) },
  ];
  for (const payload of payloads) {
    const embedder = createEmbedder(config, {
      fetchImpl: async () => ({ ok: true, json: async () => payload }),
    });
    await assert.rejects(embedder.embed(['a', 'b']), safeError('INVALID_RESPONSE'));
  }
});

test('enforces explicit dimensions', async () => {
  const embedder = createEmbedder(
    { ...config, dimensions: 3 },
    {
      fetchImpl: async () => response([item(0, [1, 2])]),
    },
  );
  await assert.rejects(embedder.embed(['text']), safeError('INVALID_RESPONSE'));
});

test('enforces inferred dimensions across batches and later calls', async () => {
  let calls = 0;
  const embedder = createEmbedder(
    { ...config, batchSize: 1 },
    {
      fetchImpl: async () => response([item(0, calls++ === 0 ? [1, 2] : [1, 2, 3])]),
    },
  );
  await assert.rejects(embedder.embed(['a', 'b']), safeError('INVALID_RESPONSE'));
  assert.equal(calls, 2);
  await assert.rejects(embedder.embed(['later']), safeError('INVALID_RESPONSE'));
});

test('does not lock inferred dimensions from a malformed batch', async () => {
  let calls = 0;
  const embedder = createEmbedder(config, {
    fetchImpl: async () =>
      response(calls++ === 0 ? [item(0, [1]), item(0, [2])] : [item(0, [1, 2])]),
  });
  await assert.rejects(embedder.embed(['a', 'b']), safeError('INVALID_RESPONSE'));
  assert.deepEqual(await embedder.embed(['valid']), [[1, 2]]);
});

test('concurrent calls share the first fully validated dimension', async () => {
  const first = deferred<FetchResponse>();
  let calls = 0;
  const embedder = createEmbedder(config, {
    fetchImpl: async () => (calls++ === 0 ? first.promise : response([item(0, [1, 2, 3])])),
  });
  const pending = embedder.embed(['slow']);
  assert.deepEqual(await embedder.embed(['fast']), [[1, 2, 3]]);
  first.resolve(response([item(0, [1, 2])]));
  await assert.rejects(pending, safeError('INVALID_RESPONSE'));
});

test('HTTP failures are not retried and response bodies are not read or leaked', async () => {
  let calls = 0;
  let requestSignal: AbortSignal | undefined;
  const embedder = createEmbedder(
    { ...config, batchSize: 1 },
    {
      fetchImpl: async (_, init) => {
        calls++;
        requestSignal = init.signal;
        return {
          ok: false,
          status: 429,
          statusText: SECRET,
          json: () => assert.fail('error body must not be read'),
          text: () => assert.fail('error body must not be read'),
        };
      },
    },
  );
  await assert.rejects(embedder.embed(['a', 'b']), safeError('HTTP_ERROR'));
  assert.equal(calls, 1);
  assert.ok(requestSignal);
  assert.equal(requestSignal.aborted, true);
});

test('sanitizes sync and async network errors rather than retaining the original object', async () => {
  const original = Object.assign(new Error(`Request failed: Bearer ${SECRET}`), {
    cause: new Error(SECRET),
    request: { headers: { Authorization: SECRET } },
  });
  for (const fetchImpl of [
    () => {
      throw original;
    },
    async () => {
      throw original;
    },
  ]) {
    const embedder = createEmbedder(config, { fetchImpl });
    await assert.rejects(embedder.embed(['text']), (error) => {
      assert.notEqual(error, original);
      return safeError('NETWORK_ERROR')(error);
    });
  }
});

test('sanitizes JSON parse errors and malformed response accessors', async () => {
  const responses = [
    {
      ok: true,
      json: async () => {
        throw new Error(SECRET);
      },
    },
    {
      ok: true,
      json: async () => ({
        get data() {
          throw new Error(SECRET);
        },
      }),
    },
    { ok: true, json: async () => ({ data: [item(0, [SECRET])] }) },
  ];
  for (const result of responses) {
    await assert.rejects(
      createEmbedder(config, { fetchImpl: async () => result }).embed(['text']),
      safeError('INVALID_RESPONSE'),
    );
  }
});

test('pre-cancelled input does not fetch or leak abort reasons', async () => {
  await assert.rejects(
    createEmbedder(config, { fetchImpl: unusedFetch }).embed(
      ['text'],
      AbortSignal.abort(new Error(SECRET)),
    ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'AbortError');
      return safeError('ABORTED')(error);
    },
  );
});

test('in-flight cancellation settles even when fetch ignores its signal', async () => {
  const controller = new AbortController();
  const held = deferred<FetchResponse>();
  let requestSignal: AbortSignal | undefined;
  let calls = 0;
  const embedder = createEmbedder(
    { ...config, batchSize: 1 },
    {
      fetchImpl: (_, init) => {
        calls++;
        requestSignal = init.signal;
        return held.promise;
      },
    },
  );
  const pending = embedder.embed(['a', 'b'], controller.signal);
  const rejected = assert.rejects(pending, safeError('ABORTED'));
  controller.abort(new Error(SECRET));
  await rejected;
  assert.ok(requestSignal);
  assert.equal(requestSignal.aborted, true);
  assert.equal(inspect(requestSignal.reason).includes(SECRET), false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(calls, 1);
  held.reject(new Error(SECRET));
});

test('cancellation bounds response.json and prevents later batches', async () => {
  const controller = new AbortController();
  const started = deferred();
  let calls = 0;
  const embedder = createEmbedder(
    { ...config, batchSize: 1 },
    {
      fetchImpl: async () => {
        calls++;
        return {
          ok: true,
          json: () => {
            started.resolve();
            return new Promise(() => {});
          },
        };
      },
    },
  );
  const pending = embedder.embed(['a', 'b'], controller.signal);
  await started.promise;
  const rejected = assert.rejects(pending, safeError('ABORTED'));
  controller.abort(SECRET);
  await rejected;
  assert.equal(calls, 1);
});

test('times out hanging fetch after 30 seconds without real waiting or network', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal: AbortSignal | undefined;
  const embedder = createEmbedder(config, {
    fetchImpl: (_, init) => {
      requestSignal = init.signal;
      return new Promise(() => {});
    },
  });
  const pending = embedder.embed(['text']);
  const rejected = assert.rejects(pending, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'TimeoutError');
    return safeError('TIMEOUT')(error);
  });
  t.mock.timers.tick(29_999);
  assert.ok(requestSignal);
  assert.equal(requestSignal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.ok(requestSignal);
  assert.equal(requestSignal.aborted, true);
});

test('the same timeout also bounds response.json', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = deferred();
  const embedder = createEmbedder(config, {
    fetchImpl: async () => ({
      ok: true,
      json: () => {
        started.resolve();
        return new Promise(() => {});
      },
    }),
  });
  const pending = embedder.embed(['text']);
  const rejected = assert.rejects(pending, safeError('TIMEOUT'));
  await started.promise;
  t.mock.timers.tick(30_000);
  await rejected;
});

test('successful calls clean up timeout and caller abort listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const embedder = createEmbedder(config, {
    fetchImpl: async (_, init) => {
      requestSignal = init.signal;
      return response([item(0)]);
    },
  });
  await embedder.embed(['text'], controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  t.mock.timers.tick(30_000);
  controller.abort();
  assert.ok(requestSignal);
  assert.equal(requestSignal.aborted, false);
});
