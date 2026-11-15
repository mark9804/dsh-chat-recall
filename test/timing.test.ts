import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureTiming,
  timed,
  timedSync,
  timingEnabled,
  recordTiming,
  parseTiming,
  mergeTiming,
} from '../dist/shared/timing.js';

test('timing is opt-in and preserves ordinary operation results', async () => {
  assert.equal(timingEnabled(), false);
  assert.equal(await timed('host.search', async () => 7), 7);
  recordTiming('host.search', 1);
  const captured = await captureTiming(async () => {
    assert.equal(timingEnabled(), true);
    await timed('host.search', async () => {
      recordTiming('embedding.http', 2);
      return 3;
    });
    timedSync('embedding.validate', () => 4);
    return { ok: true };
  });
  assert.deepEqual(captured.value, { ok: true });
  assert.ok(captured.timing.totalMs >= 0);
  assert.deepEqual(
    captured.timing.spans.map((s) => s.name),
    ['embedding.http', 'host.search', 'embedding.validate'],
  );
  assert.equal(timingEnabled(), false);
});

test('parallel and nested timing contexts are isolated and callbacks cannot break outcomes', async () => {
  const [a, b] = await Promise.all([
    captureTiming(async () => {
      await Promise.resolve();
      recordTiming('host.search', 3);
      return 'a';
    }),
    captureTiming(
      async () => {
        recordTiming('host.read', 4);
        await captureTiming(async () => {
          recordTiming('store.pending', 5);
        });
        return 'b';
      },
      () => {
        throw new Error('observer-private');
      },
    ),
  ]);
  assert.deepEqual(a.timing.spans, [{ name: 'host.search', ms: 3, count: 1 }]);
  assert.deepEqual(b.timing.spans, [{ name: 'host.read', ms: 4, count: 1 }]);
  let report = false;
  const failure = new Error('operation');
  await assert.rejects(
    captureTiming(
      async () => {
        await timed('host.search', async () => {
          throw failure;
        });
      },
      (r) => {
        report = r.spans.some((s) => s.name === 'host.search');
        throw new Error('ignored');
      },
    ),
    (error) => error === failure,
  );
  assert.equal(report, true);
});

test('wire timing accepts only bounded known numeric spans and strips extra fields', async () => {
  const valid = {
    totalMs: 12,
    secret: 'never-retain',
    spans: [{ name: 'store.pending', ms: 3, count: 2, query: 'private' }],
  };
  assert.deepEqual(parseTiming(valid), {
    totalMs: 12,
    spans: [{ name: 'store.pending', ms: 3, count: 2 }],
  });
  for (const input of [
    null,
    {},
    { ...valid, totalMs: NaN },
    { ...valid, spans: [{ name: 'secret-value', ms: 1, count: 1 }] },
    { ...valid, spans: [{ name: 'host.read', ms: -1, count: 1 }] },
    { ...valid, spans: [{ name: 'host.read', ms: 1, count: 0 }] },
    { ...valid, spans: [...valid.spans, ...valid.spans] },
  ])
    assert.equal(parseTiming(input), undefined);
  const result = await captureTiming(async () => {
    mergeTiming(parseTiming(valid)!);
    recordTiming('store.pending', 1);
    recordTiming('host.read', Infinity);
  });
  assert.deepEqual(result.timing.spans, [{ name: 'store.pending', ms: 4, count: 3 }]);
});
