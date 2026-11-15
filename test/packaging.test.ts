import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const original = join(dirname(require.resolve('@lancedb/lancedb')), '..');
const copied = new URL('../dist/vendor/lancedb/', import.meta.url);

test('release copies upstream LanceDB runtime bytes and retains redistribution notices', async () => {
  let files = 0;
  async function compare(relative: string): Promise<void> {
    for (const entry of await readdir(join(original, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await compare(path);
      else {
        assert.deepEqual(
          await readFile(new URL(path, copied)),
          await readFile(join(original, path)),
          path,
        );
        files++;
      }
    }
  }
  await compare('dist');
  assert.ok(files > 20);
  for (const notice of [
    'LICENSE',
    'PROVENANCE.md',
    'NODEJS_THIRD_PARTY_LICENSES.md',
    'RUST_THIRD_PARTY_LICENSES.html',
  ])
    assert.ok((await readFile(new URL(notice, copied))).length > 50);
});

test('release graph excludes optional embedding SDKs and installs native packages normally', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>;
    optionalDependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies['@lancedb/lancedb'], undefined);
  assert.equal(pkg.devDependencies['@lancedb/lancedb'], '0.41.0');
  for (const name of [
    'openai',
    '@huggingface/transformers',
    'onnxruntime-node',
    'sharp',
    'protobufjs',
  ])
    assert.equal(pkg.dependencies[name], undefined);
  assert.equal(Object.keys(pkg.optionalDependencies).length, 7);
  assert.ok(
    Object.keys(pkg.optionalDependencies).every((name) => name.startsWith('@lancedb/lancedb-')),
  );
  const vendor = JSON.parse(await readFile(new URL('package.json', copied), 'utf8')) as Record<
    string,
    unknown
  >;
  assert.equal(vendor.type, 'commonjs');
  assert.equal(vendor.dependencies, undefined);
  assert.equal(vendor.optionalDependencies, undefined);
  assert.equal(vendor.scripts, undefined);
});
