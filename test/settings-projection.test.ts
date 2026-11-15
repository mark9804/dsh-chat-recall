import test from 'node:test';
import assert from 'node:assert/strict';
import Schema from '@deepseek-ai/schemastery';
import { Config } from '../dist/host/plugin.js';
import { snapshotConfig } from '../dist/host/config.js';

test('editable settings serialize to an object form with every supported field', () => {
  const serialized = JSON.parse(JSON.stringify(Config.toJSON())) as {
    uid: number;
    refs: Record<
      string,
      { type: string; dict?: Record<string, number>; meta?: Record<string, unknown> }
    >;
  };
  const root = serialized.refs[serialized.uid];
  assert.equal(root.type, 'object');
  assert.ok(root.dict);
  const fields = [
    'nodePath',
    'dataPath',
    'sessionIds',
    'embeddingSessionIds',
    'envFile',
    'callerSessionIds',
    'autoSync',
    'dominantMin',
    'dominantGap',
  ];
  assert.deepEqual(Object.keys(root.dict).sort(), fields.sort());
  for (const field of fields)
    assert.ok(
      serialized.refs[root.dict[field]].meta?.volatile,
      `${field} must be visible to DSH settings`,
    );
  const restored = new Schema(serialized as unknown as ConstructorParameters<typeof Schema>[0]);
  assert.doesNotThrow(
    () => restored(snapshotConfig(Config({}))),
    'shared configForms must accept the Host serialized form',
  );
});
