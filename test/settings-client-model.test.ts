import test from 'node:test';
import assert from 'node:assert/strict';
import type { PluginConfig } from '../dist/host/types.js';
import * as model from '../src/client/model.ts';

const config = (patch: Partial<PluginConfig> = {}): PluginConfig => ({
  nodePath: 'node',
  dataPath: '/synthetic/recall',
  sessionIds: [],
  embeddingSessionIds: [],
  callerSessionIds: [],
  autoSync: true,
  autoEmbed: false,
  dominantMin: 0.5,
  dominantGap: 0.15,
  ...patch,
});

test('Off, Selected and All scopes round-trip without widening unchanged grants', () => {
  for (const patch of [
    {},
    { sessionIds: ['archived'], embeddingSessionIds: ['archived'] },
    { sessionIds: ['all'], embeddingSessionIds: ['all'], autoEmbed: true },
  ]) {
    const saved = config(patch);
    assert.deepEqual(model.configuration(saved), saved);
    const checked = model.validate(model.draftOf(saved));
    assert.deepEqual(checked, { value: saved, errors: [] });
    assert.deepEqual(model.confirmations(saved, checked.value), { local: false, outbound: false });
  }
});

test('selected IDs normalize blanks and duplicates, but never accept all or empty selection', () => {
  const draft = model.draftOf(config());
  draft.corpus = { mode: 'selected', text: ' fixture \r\nfixture\n\nother' };
  assert.deepEqual(model.validate(draft).value.sessionIds, ['fixture', 'other']);
  for (const [text, error] of [
    ['all', 'invalidIds'],
    ['', 'emptySelected'],
    ['not a session', 'invalidIds'],
  ] as const) {
    draft.corpus.text = text;
    assert.ok(model.validate(draft).errors.includes(error), text);
  }
});

test('embedding requires corpus scope; background embedding also requires local sync and an outbound grant', () => {
  for (const [patch, errors] of [
    [{ sessionIds: ['a'], embeddingSessionIds: ['all'] }, []],
    [{ sessionIds: ['all'], embeddingSessionIds: ['a'] }, []],
    [{ sessionIds: ['a'], embeddingSessionIds: ['b'] }, ['invalidSubset']],
    [{ embeddingSessionIds: ['all'] }, ['invalidSubset']],
    [
      { sessionIds: ['a'], embeddingSessionIds: ['a'], autoSync: false, autoEmbed: true },
      ['invalidAutoEmbed'],
    ],
    [{ sessionIds: ['a'], autoEmbed: true }, ['invalidAutoEmbed']],
  ] satisfies [Partial<PluginConfig>, string[]][]) {
    const input = config(patch);
    const { value, errors: actual } = model.validate(model.draftOf(input));
    assert.deepEqual(actual, errors);
    assert.equal(
      value.autoEmbed,
      input.autoEmbed,
      'validation must not downgrade an explicit choice',
    );
  }
});

test('local and outbound grants and enabling automatic embedding need explicit confirmation', () => {
  const first = config({ sessionIds: ['a'] });
  assert.deepEqual(model.confirmations(config(), first), { local: true, outbound: false });
  const outbound = config({ sessionIds: ['a'], embeddingSessionIds: ['a'] });
  assert.deepEqual(model.confirmations(first, outbound), { local: false, outbound: true });
  assert.equal(
    model.confirmations(outbound, { ...outbound, envFile: '/synthetic/new.env' }).outbound,
    true,
  );
  assert.equal(
    model.confirmations(outbound, { ...outbound, sessionIds: ['a', 'b'] }).outbound,
    true,
  );
  assert.equal(
    model.confirmations(config({ sessionIds: ['a'], autoSync: false }), first).local,
    true,
  );
  assert.equal(model.confirmations(outbound, config()).outbound, false);
  const automatic = { ...outbound, autoEmbed: true };
  assert.deepEqual(model.confirmations(outbound, automatic), { local: false, outbound: true });
  assert.deepEqual(model.confirmations(automatic, outbound), { local: false, outbound: false });
});

test('invalid paths and threshold drafts cannot be saved', () => {
  const draft = model.draftOf(config());
  draft.envFile = 'OPENAI_API_KEY=not-a-file';
  draft.nodePath = './node';
  draft.dataPath = 'relative';
  draft.dominantMin = '';
  draft.dominantGap = '3';
  for (const key of [
    'invalidEnv',
    'invalidNode',
    'invalidData',
    'invalidMin',
    'invalidGap',
  ] as const)
    assert.ok(model.validate(draft).errors.includes(key));
});

test('save uses one complete operation list and unsets only the optional env override', () => {
  const value = config();
  const operations = model.operations(value);
  assert.equal(operations.length, 10);
  assert.deepEqual(
    new Map(operations.map((op) => [op.path.join('.'), op])),
    new Map<string, unknown>([
      ...Object.entries(value).map(
        ([field, value]) => [field, { op: 'set', path: [field], value }] as const,
      ),
      ['envFile', { op: 'unset', path: ['envFile'] }],
    ]),
  );
  assert.deepEqual(
    model
      .operations(config({ envFile: '/synthetic/key.env' }))
      .find((op) => op.path[0] === 'envFile'),
    { op: 'set', path: ['envFile'], value: '/synthetic/key.env' },
  );
});
