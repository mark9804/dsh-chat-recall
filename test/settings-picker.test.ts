import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionListSnapshot } from '../src/client/contracts.js';
import * as picker from '../src/client/model.ts';

const entries: picker.CatalogEntry[] = [
  { id: 'main-a', title: 'Research notes', cwd: '/synthetic/Project Alpha' },
  { id: 'main-b', title: '旅行计划', cwd: '/synthetic/travel' },
  { id: 'fork-c', title: '', cwd: '' },
];
const selected = (text: string): picker.ScopeDraft => ({ mode: 'selected', text });
const snapshot = (patch: Partial<SessionListSnapshot> = {}): SessionListSnapshot => ({
  ids: entries.map((entry) => entry.id),
  byId: Object.fromEntries(
    entries.map((entry) => [entry.id, { ...entry, displayTitle: entry.title }]),
  ),
  phase: 'ready',
  ...patch,
});

test('public ids/byId catalog reads only metadata, keeps forks and excludes invalid or subagent IDs', () => {
  const main = {
    id: 'main-a',
    displayTitle: 'Display fallback',
    title: '  A title  ',
    cwd: '/synthetic/a',
    get projectionValues(): never {
      throw new Error('projection details must not be read');
    },
    get messages(): never {
      throw new Error('message content must not be read');
    },
  };
  const fork = { id: 'fork-b', parentId: 'main-a', displayTitle: 'User fork' };
  const publicSnapshot = {
    ...snapshot({
      ids: ['main-a', 'main-a', 'fork-b', 'child-c', 'all', '', 'bad id', 'missing', 'mismatch'],
      byId: {
        'main-a': main,
        'fork-b': fork,
        'child-c': { id: 'child-c', origin: 'subagent', displayTitle: 'Not a main conversation' },
        all: { id: 'all', displayTitle: '' },
        '': { id: '', displayTitle: '' },
        'bad id': { id: 'bad id', displayTitle: '' },
        mismatch: { id: 'other', displayTitle: '' },
      },
    }),
    get projectionsBySession(): never {
      throw new Error('content projections must not be read');
    },
    get state(): never {
      throw new Error('internal manager state is not public');
    },
    get error(): never {
      throw new Error('internal manager error is not public');
    },
  };
  assert.deepEqual(picker.sessionCatalog(publicSnapshot), {
    entries: [
      { id: 'main-a', title: 'A title', cwd: '/synthetic/a' },
      { id: 'fork-b', title: 'User fork', cwd: '' },
    ],
    state: 'ready',
    refreshing: false,
    stale: false,
  });
});

test('catalog handles public pending/ready states and unsupported shapes without crashing', () => {
  const empty = { ids: [], byId: {} };
  assert.equal(picker.sessionCatalog(snapshot({ ...empty, phase: 'pending' })).state, 'loading');
  assert.equal(picker.sessionCatalog(snapshot(empty)).state, 'ready');
  for (const invalid of [
    undefined,
    null,
    {},
    { items: [] },
    { ids: [], byId: null },
    { ids: [], byId: [] },
  ]) {
    const result = picker.sessionCatalog(invalid as unknown as SessionListSnapshot);
    assert.equal(result.state, 'unavailable');
    assert.deepEqual(result.entries, []);
  }
});

test('catalog equality ignores running changes but detects title, cwd, order and availability', () => {
  const a = picker.sessionCatalog(snapshot());
  const runningRows = Object.fromEntries(
    Object.entries(snapshot().byId).map(([id, item]) => [
      id,
      { ...item!, running: true, updatedAt: 100 },
    ]),
  );
  assert.equal(picker.sameCatalog(a, picker.sessionCatalog(snapshot({ byId: runningRows }))), true);
  const changed = { ...a, entries: a.entries.map((entry) => ({ ...entry })) };
  changed.entries[0]!.title = 'Changed';
  assert.equal(picker.sameCatalog(a, changed), false);
  changed.entries[0]!.title = a.entries[0]!.title;
  changed.entries[0]!.cwd = '/synthetic/different';
  assert.equal(picker.sameCatalog(a, changed), false);
  assert.equal(picker.sameCatalog(a, { ...a, entries: [...a.entries].reverse() }), false);
  assert.equal(picker.sameCatalog(a, picker.sessionCatalog(snapshot({ phase: 'pending' }))), false);
});

test('local metadata search handles Chinese, case-insensitive title/ID/cwd and multi-term queries', () => {
  const ids = (query: string): string[] =>
    picker.searchEntries(entries, query).map((entry) => entry.id);
  assert.deepEqual(ids('research'), ['main-a']);
  assert.deepEqual(ids('MAIN-B'), ['main-b']);
  assert.deepEqual(ids('project ALPHA'), ['main-a']);
  assert.deepEqual(ids('research /synthetic'), ['main-a']);
  assert.deepEqual(ids('旅行'), ['main-b']);
  assert.deepEqual(ids('fork-c'), ['fork-c']);
  assert.deepEqual(ids('research travel'), []);
  assert.deepEqual(ids('no-such-session'), []);
  assert.strictEqual(picker.searchEntries(entries, ' \n\t '), entries);
});

test('embedding candidates follow the draft corpus, never metadata arrivals', () => {
  const before = selected('main-a\narchived');
  assert.strictEqual(picker.pickerEntries(entries), entries);
  assert.deepEqual(picker.pickerEntries(entries, before), [entries[0]]);
  assert.deepEqual(picker.pickerEntries(entries, selected('')), []);
  for (const mode of ['off', 'all'] as const) {
    const scope = { mode, text: 'main-a' };
    assert.deepEqual(picker.pickerEntries(entries, scope), mode === 'all' ? entries : []);
    assert.deepEqual(picker.pickerSelections(scope, entries), []);
  }
  const arrival = [...entries, { id: 'new-conversation', title: 'New', cwd: '' }];
  assert.deepEqual(picker.pickerEntries(arrival, before), [entries[0]]);
  assert.deepEqual(before, selected('main-a\narchived'));
});

test('saved missing IDs remain visible, searchable and removable while the catalog is unavailable', () => {
  const scope = selected('archived\nmain-a\narchived');
  const result = picker.pickerSelections(scope, entries);
  assert.deepEqual(result, [
    { id: 'archived', title: '', cwd: '', missing: true, allowed: true },
    { ...entries[0], missing: false, allowed: true },
  ]);
  assert.deepEqual(picker.searchEntries(result, 'archived'), [result[0]]);
  const unavailable = picker.pickerSelections(scope, []);
  assert.equal(unavailable.length, 2);
  assert.ok(unavailable.every((entry) => entry.missing));
  assert.deepEqual(picker.toggleSelection(scope, 'archived', false, []), selected('main-a'));
  assert.deepEqual(scope, selected('archived\nmain-a\narchived'));
});

test('shrinking a corpus flags embedding selections without dropping IDs or switching modes', () => {
  const scope = selected('main-a\nmain-b\narchived');
  const corpus = selected('main-a\narchived');
  assert.deepEqual(
    picker
      .pickerSelections(scope, entries, corpus)
      .map((entry) => [entry.id, entry.allowed, entry.missing]),
    [
      ['main-a', true, false],
      ['main-b', false, false],
      ['archived', true, true],
    ],
  );
  assert.ok(
    picker
      .pickerSelections(scope, entries, { mode: 'off', text: '' })
      .every((entry) => !entry.allowed),
  );
  assert.deepEqual(scope, selected('main-a\nmain-b\narchived'));
});

test('checkbox toggles preserve modes and reject duplicate, unknown or out-of-corpus additions', () => {
  const scope = selected('archived');
  const added = picker.toggleSelection(scope, 'main-a', true, entries);
  assert.deepEqual(added, selected('archived\nmain-a'));
  assert.deepEqual(picker.toggleSelection(selected('main-a'), 'main-a', false, []), selected(''));
  const eligible = picker.pickerEntries(entries, selected('main-a'));
  for (const [value, id, checked, available] of [
    [added, 'main-a', true, entries],
    [scope, 'unknown', false, []],
    [scope, 'unknown', true, entries],
    [scope, '', true, entries],
    [scope, 'all', true, entries],
    [scope, 'bad id', true, entries],
    [scope, 'main-b', true, eligible],
    [{ mode: 'off', text: 'archived' }, 'main-a', true, entries],
    [{ mode: 'off', text: 'archived' }, 'archived', false, []],
    [{ mode: 'all', text: 'archived' }, 'main-a', true, entries],
    [{ mode: 'all', text: 'archived' }, 'archived', false, []],
  ] as const)
    assert.strictEqual(picker.toggleSelection(value, id, checked, available), value);
  assert.deepEqual(scope, selected('archived'));
});

test('pagination preserves 50-row boundaries and clamps stale or invalid positions', () => {
  const many = Array.from({ length: 103 }, (_, index) => ({
    id: `id-${index}`,
    title: '',
    cwd: '',
  }));
  for (const [count, requested, page, from, to, hasPrevious, hasMore] of [
    [0, 50, 0, 0, 0, false, false],
    [50, 0, 0, 1, 50, false, false],
    [51, 0, 0, 1, 50, false, true],
    [51, 1, 1, 51, 51, true, false],
    [103, 99999, 2, 101, 103, true, false],
    [103, -2, 0, 1, 50, false, true],
    [103, Infinity, 0, 1, 50, false, true],
    [103, NaN, 0, 1, 50, false, true],
    [103, 1.9, 1, 51, 100, true, true],
  ] as const) {
    const items = many.slice(0, count);
    assert.deepEqual(picker.pickerPage(items, requested), {
      items: items.slice(from ? from - 1 : 0, to),
      page,
      count,
      from,
      to,
      hasPrevious,
      hasMore,
    });
  }
  const matches = picker.searchEntries(many, 'id-102');
  assert.equal(picker.pickerPage(matches, 999).items[0]!.id, 'id-102');
});
