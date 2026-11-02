import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const source = resolve(dirname(require.resolve('@lancedb/lancedb')), '..');
const target = resolve('dist/vendor/lancedb');
const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as {
  version: string;
  license: string;
  dependencies: Record<string, string>;
};
if (pkg.version !== '0.41.0' || pkg.license !== 'Apache-2.0') {
  throw new Error('Review the vendor/dependency contract before upgrading LanceDB.');
}
await mkdir(target, { recursive: true });
// Keep upstream bytes unchanged, including native loader and declarations.
await cp(join(source, 'dist'), join(target, 'dist'), { recursive: true });
for (const file of [
  'NODEJS_THIRD_PARTY_LICENSES.md',
  'RUST_THIRD_PARTY_LICENSES.html',
  'license_header.txt',
]) {
  await cp(join(source, file), join(target, file));
}
await cp(resolve('licenses/lancedb-Apache-2.0.txt'), join(target, 'LICENSE'));
await writeFile(
  join(target, 'package.json'),
  JSON.stringify(
    {
      name: '@lancedb/lancedb',
      version: pkg.version,
      type: 'commonjs',
      main: 'dist/index.js',
      license: pkg.license,
    },
    null,
    2,
  ) + '\n',
);
await writeFile(
  join(target, 'PROVENANCE.md'),
  `# Build-only LanceDB copy\n\nSource: @lancedb/lancedb@${pkg.version} from the locked npm development dependency.\nUpstream repository: https://github.com/lancedb/lancedb\n\nThe dist files and upstream notices are copied without changes. This reduced\npackage manifest intentionally omits optional OpenAI/Transformers integrations.\nThe plugin uses its own fetch embedding client. Required Arrow, OpenTelemetry,\nreflect-metadata and platform native packages are declared by the outer plugin.\n\nThis directory is generated; edit the TypeScript build script, not these files.\n`,
);
console.log('Copied unmodified LanceDB JS without optional model SDK dependencies.');
