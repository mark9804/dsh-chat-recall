import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchPages, type SearchPagesOptions } from '../dist/core/cursors.js';
import { chooseCandidates } from '../dist/core/candidates.js';

interface SyntheticHit {
  ref: string;
  similarity?: number;
  text?: string;
  detail?: { index: number };
}
const cursorOf = (page: { nextCursor: string | null }): string => {
  assert.ok(page.nextCursor);
  return page.nextCursor;
};

// Each test owns a new synthetic directory. No existing/user file is deleted,
// and expired snapshot files intentionally remain as required by the contract.
const directory = () => mkdtemp(join(tmpdir(), 'dsh-synthetic-search-pages-'));
const binding = JSON.stringify({
  caller: 'synthetic-caller',
  query: 'synthetic query',
  scope: ['synthetic-session'],
});
const hits = (count = 8) =>
  Array.from({ length: count }, (_, i) => ({
    ref: `synthetic-${i}`,
    similarity: i === 0 ? 0.9 : 0.5 - i / 100,
    text: `body-${i}`,
    detail: { index: i },
  }));
const errorCode = (code: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === code;

async function pages<Meta extends object = Record<string, unknown>, Presentation = unknown>(
  options: SearchPagesOptions = {},
) {
  return new SearchPages<SyntheticHit, Meta, Presentation>({
    directory: await directory(),
    ...options,
  });
}

test('all candidates are paged exactly once with no reranking or index callbacks', async () => {
  const pager = await pages();
  const original = hits(11);
  let page = await pager.create({
    binding,
    hits: original,
    pageSize: 3,
    presentation: { policy: 'synthetic' },
    meta: { truncated: true },
  });
  const seen: string[] = [];
  while (true) {
    seen.push(...page.hits.map((hit) => hit.ref));
    assert.equal(page.totalCandidates, 11);
    assert.equal(page.truncated, true);
    assert.deepEqual(page.presentation, { policy: 'synthetic' });
    if (!page.nextCursor) break;
    assert.equal(typeof page.nextCursor, 'string');
    assert.equal(page.nextCursor.includes('synthetic query'), false);
    page = await pager.next({ cursor: page.nextCursor, binding, limit: 2 });
  }
  assert.deepEqual(
    seen,
    original.map((hit) => hit.ref),
  );
  assert.equal(new Set(seen).size, 11);
  assert.equal(page.nextCursor, null);
});

test('top-three score summaries do not consume hidden bodies: continuation starts at one', async () => {
  const pager = await pages();
  const candidates = hits();
  const presentation = chooseCandidates(candidates);
  assert.equal(presentation.count, 1);
  assert.equal(presentation.comparison.top3.length, 3);
  const first = await pager.create({
    binding,
    hits: candidates,
    pageSize: presentation.count,
    presentation,
  });
  assert.deepEqual(
    first.hits.map((hit) => hit.ref),
    ['synthetic-0'],
  );
  const second = await pager.next({ binding, cursor: cursorOf(first), limit: 3 });
  assert.deepEqual(
    second.hits.map((hit) => hit.ref),
    ['synthetic-1', 'synthetic-2', 'synthetic-3'],
  );
  assert.deepEqual(second.presentation, presentation);
});

test('input mutation, response mutation, and new searches cannot alter old snapshots', async () => {
  const pager = await pages<
    { indexVersion: number; detail?: { source: string } },
    { comparison: { top3: { ref: string; score: number }[] } }
  >();
  const candidates: SyntheticHit[] = hits(7);
  const presentation = { comparison: { top3: [{ ref: 'synthetic-0', score: 0.9 }] } };
  const meta = { indexVersion: 1, detail: { source: 'old' } };
  const pending = pager.create({ binding, hits: candidates, pageSize: 2, presentation, meta });
  candidates[2].text = 'new index text';
  assert.ok(candidates[2].detail);
  candidates[2].detail.index = 99;
  candidates.unshift({ ref: 'new index candidate' });
  presentation.comparison.top3[0].score = 0;
  meta.detail.source = 'changed';
  const first = await pending;
  first.presentation.comparison.top3[0].score = -1;
  assert.ok(first.detail);
  first.detail.source = 'changed by caller';
  await pager.create({ binding, hits: candidates, pageSize: 3, meta: { indexVersion: 2 } });
  const second = await pager.next({ cursor: cursorOf(first), binding });
  assert.deepEqual(
    second.hits.map((hit) => hit.ref),
    ['synthetic-2', 'synthetic-3'],
  );
  assert.equal(second.hits[0].text, 'body-2');
  assert.equal(second.hits[0].detail?.index, 2);
  assert.equal(second.totalCandidates, 7);
  assert.equal(second.presentation.comparison.top3[0].score, 0.9);
  assert.equal(second.detail?.source, 'old');
  assert.equal(second.indexVersion, 1);
  second.hits[0].text = 'response mutation';
  assert.equal((await pager.next({ cursor: cursorOf(first), binding })).hits[0].text, 'body-2');
});

test('caller, normalized query and scope binding must match exactly', async () => {
  const pager = await pages();
  const first = await pager.create({ binding, hits: hits(), pageSize: 2 });
  for (const field of ['caller', 'query', 'scope']) {
    const value = JSON.parse(binding);
    value[field] = field === 'scope' ? ['other-session'] : 'other-value';
    await assert.rejects(
      pager.next({ cursor: cursorOf(first), binding: JSON.stringify(value) }),
      errorCode('INVALID_CURSOR'),
    );
  }
  await assert.rejects(
    pager.next({ cursor: cursorOf(first), binding: {} as unknown as string }),
    TypeError,
  );
  assert.equal((await pager.next({ cursor: cursorOf(first), binding })).hits[0].ref, 'synthetic-2');
});

test('cursor offset and signature tampering is rejected', async () => {
  const pager = await pages();
  const first = await pager.create({ binding, hits: hits(), pageSize: 2 });
  const token = JSON.parse(Buffer.from(cursorOf(first), 'base64url').toString());
  token[3] += 1;
  await assert.rejects(
    pager.next({ cursor: Buffer.from(JSON.stringify(token)).toString('base64url'), binding }),
    errorCode('INVALID_CURSOR'),
  );
  for (const cursor of [
    '',
    'not-a-cursor',
    '{}',
    first.nextCursor + '=',
    123,
    null,
    'a'.repeat(1025),
  ]) {
    await assert.rejects(
      pager.next({ cursor: cursor as unknown as string, binding }),
      errorCode('INVALID_CURSOR'),
    );
  }
});

test('expiration is explicit and prunes memory without deleting any disk files', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const dir = await directory();
  const pager = new SearchPages<SyntheticHit>({ directory: dir, ttlMs: 10, maxSnapshots: 1 });
  const first = await pager.create({ binding, hits: hits(), pageSize: 2 });
  now = 1009;
  assert.equal((await pager.next({ cursor: cursorOf(first), binding })).hits.length, 2);
  now = 1010;
  await assert.rejects(
    pager.next({ cursor: cursorOf(first), binding }),
    errorCode('CURSOR_EXPIRED'),
  );
  await pager.create({ binding, hits: hits(), pageSize: 2 });
  assert.equal((await readdir(dir)).length, 2);
});

test('restart always expires old cursors, even though the JSON snapshots remain', async () => {
  const dir = await directory();
  const firstInstance = new SearchPages<SyntheticHit>({ directory: dir });
  const first = await firstInstance.create({ binding, hits: hits(), pageSize: 2 });
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f-]+\.json$/);
  const snapshot = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
  assert.equal(snapshot.hits.length, 8);
  assert.equal(snapshot.binding, binding);
  assert.equal(Object.hasOwn(snapshot, 'key'), false);
  const restarted = new SearchPages<SyntheticHit>({ directory: dir });
  await assert.rejects(
    restarted.next({ cursor: cursorOf(first), binding }),
    errorCode('CURSOR_EXPIRED'),
  );
  const newSearch = await restarted.create({ binding, hits: hits(3), pageSize: 1 });
  assert.equal(
    (await restarted.next({ cursor: cursorOf(newSearch), binding })).hits[0].ref,
    'synthetic-1',
  );
  assert.equal((await readdir(dir)).length, 2);
});

test('active snapshot capacity fails explicitly and does not evict a valid cursor', async () => {
  const pager = await pages({ maxSnapshots: 1 });
  const first = await pager.create({ binding, hits: hits(), pageSize: 1 });
  await assert.rejects(
    pager.create({ binding, hits: hits(2), pageSize: 1 }),
    errorCode('SEARCH_CAPACITY'),
  );
  assert.equal((await pager.next({ cursor: cursorOf(first), binding })).hits[0].ref, 'synthetic-1');
});

test('concurrent creates reserve capacity before any file IO', async () => {
  const pager = await pages({ maxSnapshots: 2 });
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => pager.create({ binding, hits: hits(), pageSize: 2 })),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(rejected.length, 8);
  assert.ok(rejected.every((result) => result.reason.code === 'SEARCH_CAPACITY'));
});

test('metadata cannot override pagination fields and does not inject another cursor', async () => {
  const pager = await pages();
  const first = await pager.create({
    binding,
    hits: hits(3),
    pageSize: 1,
    presentation: { trusted: true },
    meta: {
      hits: [{ ref: 'forged' }],
      nextCursor: 'forged',
      cursor: 'forged',
      totalCandidates: 999,
      presentation: { forged: true },
      truncated: true,
      candidateCap: 100,
    },
  });
  assert.equal(first.hits[0].ref, 'synthetic-0');
  assert.notEqual(first.nextCursor, 'forged');
  assert.equal(Object.hasOwn(first, 'cursor'), false);
  assert.equal(first.totalCandidates, 3);
  assert.deepEqual(first.presentation, { trusted: true });
  assert.equal(first.truncated, true);
  assert.equal(first.candidateCap, 100);
  const second = await pager.next({ cursor: cursorOf(first), binding });
  assert.equal(second.hits[0].ref, 'synthetic-1');
  assert.equal(Object.hasOwn(second, 'cursor'), false);
});

test('empty and single-page snapshots have no cursor; page size zero is only for empty results', async () => {
  const pager = await pages();
  assert.deepEqual(await pager.create({ binding, hits: [], pageSize: 0 }), {
    hits: [],
    nextCursor: null,
    totalCandidates: 0,
    presentation: null,
  });
  assert.equal((await pager.create({ binding, hits: hits(1), pageSize: 20 })).nextCursor, null);
  await assert.rejects(pager.create({ binding, hits: hits(1), pageSize: 0 }), RangeError);
});

test('existing files are not deleted or overwritten and IO failure releases capacity', async () => {
  const dir = await directory();
  const sentinel = join(dir, 'synthetic-sentinel.txt');
  await writeFile(sentinel, 'synthetic preserved file', { flag: 'wx' });
  const pager = new SearchPages<SyntheticHit>({ directory: dir });
  await pager.create({ binding, hits: hits(3), pageSize: 1 });
  assert.equal(await readFile(sentinel, 'utf8'), 'synthetic preserved file');
  const broken = new SearchPages<SyntheticHit>({ directory: sentinel, maxSnapshots: 1 });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      broken.create({ binding, hits: hits(3), pageSize: 1 }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string' &&
        ['EEXIST', 'ENOTDIR'].includes(error.code),
    );
  }
});

test('invalid configuration, sizes and non-serializable inputs fail early', async () => {
  assert.throws(() => new SearchPages(), TypeError);
  assert.throws(
    () => new SearchPages<SyntheticHit>({ directory: '/synthetic-unused', ttlMs: -1 }),
    RangeError,
  );
  assert.throws(
    () => new SearchPages<SyntheticHit>({ directory: '/synthetic-unused', maxSnapshots: 0 }),
    RangeError,
  );
  const pager = await pages({ maxSnapshots: 1 });
  for (const pageSize of [-1, 21, 1.5, NaN, null]) {
    await assert.rejects(
      pager.create({ binding, hits: hits(), pageSize: pageSize as unknown as number }),
      RangeError,
    );
  }
  const circular: { self?: unknown } = {};
  circular.self = circular;
  await assert.rejects(
    pager.create({ binding, hits: [circular as unknown as SyntheticHit] }),
    TypeError,
  );
  const first = await pager.create({ binding, hits: hits(), pageSize: 1 });
  await assert.rejects(pager.next({ binding, cursor: cursorOf(first), limit: 0 }), RangeError);
});
