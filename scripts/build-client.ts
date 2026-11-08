import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entryPoint = 'src/client/settings.ts';
const outputPath = resolve(projectRoot, 'dist/client/settings.js');
// Only the DSH shell's shared React runtime may remain outside this bundle.
const external = ['react', 'react-dom', 'react/jsx-runtime'];
const sharedRuntime = new Set(external);
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const portable = (path: string): string => path.split(sep).join('/');

function packageName(input: string): string | undefined {
  const parts = input.replaceAll('\\', '/').split('/');
  const index = parts.lastIndexOf('node_modules');
  if (index === -1) return undefined;
  const name = parts[index + 1];
  if (!name || name === '.pnpm' || (name.startsWith('@') && !parts[index + 2])) {
    throw new Error(`Cannot identify bundled dependency: ${input}`);
  }
  return name.startsWith('@') ? `${name}/${parts[index + 2]}` : name;
}

interface PackageSource {
  root: string;
  name: string;
  version: string;
  license: string;
  inputs: string[];
}
interface Notice {
  source: string;
  title: string;
  start: number;
  end: number;
  sha256: string;
}

async function dependency(input: string, expectedName: string): Promise<PackageSource> {
  let directory = dirname(await realpath(resolve(projectRoot, input)));
  for (;;) {
    let manifest: { name?: unknown; version?: unknown; license?: unknown } | undefined;
    try {
      manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Some packages have nested, type-only package.json files. Keep walking to
    // the owning package instead of attributing its helpers to the application.
    if (typeof manifest?.name === 'string') {
      if (
        manifest.name !== expectedName ||
        typeof manifest.version !== 'string' ||
        !manifest.version ||
        typeof manifest.license !== 'string' ||
        !manifest.license.trim()
      ) {
        throw new Error(`Missing or inconsistent dependency provenance: ${input}`);
      }
      const root = portable(relative(projectRoot, directory));
      if (root.startsWith('../') || !root.split('/').includes('node_modules')) {
        throw new Error(`Bundled dependency escaped workspace node_modules: ${input}`);
      }
      return {
        root,
        name: manifest.name,
        version: manifest.version,
        license: manifest.license,
        inputs: [],
      };
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`No owning package.json for: ${input}`);
    directory = parent;
  }
}

const result = await build({
  absWorkingDir: projectRoot,
  entryPoints: [entryPoint],
  outfile: outputPath,
  tsconfig: resolve(projectRoot, 'tsconfig.client.json'),
  bundle: true,
  write: false,
  platform: 'browser',
  target: ['es2022'],
  format: 'cjs',
  jsx: 'automatic',
  external,
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  legalComments: 'eof',
  metafile: true,
});
const { metafile } = result;
const runtimeImports = [
  ...new Set(
    Object.values(metafile.outputs).flatMap((output) =>
      output.imports.filter((item) => item.external).map((item) => item.path),
    ),
  ),
].sort();
const unexpectedImports = [
  ...new Set([
    ...runtimeImports,
    ...Object.values(metafile.inputs).flatMap((input) =>
      input.imports.filter((item) => item.external).map((item) => item.path),
    ),
  ]),
].filter((path) => !sharedRuntime.has(path));
if (unexpectedImports.length) {
  throw new Error(`Unexpected browser runtime imports: ${unexpectedImports.join(', ')}`);
}
if (result.outputFiles.length !== 1 || result.outputFiles[0].path !== outputPath) {
  throw new Error('Client must produce one JavaScript bundle; CSS must use the text loader.');
}

const packages = new Map<string, PackageSource>();
for (const input of Object.keys(metafile.inputs).sort()) {
  const name = packageName(input);
  if (!name) continue;
  if (name === 'react' || name === 'react-dom') {
    throw new Error(`The shell-provided React runtime was bundled: ${input}`);
  }
  const source = await dependency(input, name);
  const item = packages.get(source.root) ?? source;
  item.inputs.push(input);
  packages.set(source.root, item);
}
if (![...packages.values()].some((item) => item.name === '@base-ui/react')) {
  throw new Error('The Client bundle must include its Base UI implementation.');
}

let notices =
  'DSH Chat Recall browser bundle third-party notices\n' +
  'React and React DOM are supplied by the DSH shell and are not bundled.\n\n';
function appendNotice(source: string, title: string, text: string): Notice {
  if (!text.trim()) throw new Error(`Empty third-party notice: ${source}`);
  notices += `=== ${title} ===\nSource: ${source}\n\n`;
  const start = notices.length;
  notices += text;
  const end = notices.length;
  notices += '\n\n';
  return { source, title, start, end, sha256: hash(text) };
}
const sourceNotices: Notice[] = [];
for (const source of ['src/client/NOTICE.md', 'src/client/SHADCN_LICENSE.txt']) {
  sourceNotices.push(
    appendNotice(source, source, await readFile(resolve(projectRoot, source), 'utf8')),
  );
}
const bundledPackages = [];
for (const item of [...packages.values()].sort((a, b) => a.root.localeCompare(b.root))) {
  const directory = resolve(projectRoot, item.root);
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((file) => file.isFile() && /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(file.name))
    .map((file) => file.name)
    .sort();
  if (!files.some((name) => /^(?:licen[cs]e|copying)(?:$|[._-])/i.test(name))) {
    throw new Error(`No license file found for bundled dependency ${item.name}@${item.version}`);
  }
  const licenseNotices: Notice[] = [];
  for (const file of files) {
    licenseNotices.push(
      appendNotice(
        `${item.root}/${file}`,
        `${item.name}@${item.version} — ${file}`,
        await readFile(resolve(directory, file), 'utf8'),
      ),
    );
  }
  bundledPackages.push({ ...item, notices: licenseNotices });
}

// The entry exports inject/apply. Only this generated classic-script wrapper
// deals with ModuleLoader; no React or stylesheet is injected into globals.
const output =
  'window.__ModuleLoader__.load({id:"dsh-chat-recall",factory(require){const module={exports:{}};const exports=module.exports;\n' +
  result.outputFiles[0].text +
  '\nreturn module.exports;}});\n';
const manifest = {
  schemaVersion: 1,
  moduleId: 'dsh-chat-recall',
  entryPoint,
  output: 'dist/client/settings.js',
  external,
  runtimeImports,
  bundleSha256: hash(output),
  noticesSha256: hash(notices),
  metafile,
  sourceNotices,
  packages: bundledPackages,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(resolve(projectRoot, 'dist/client/THIRD_PARTY_NOTICES.txt'), notices);
await writeFile(
  resolve(projectRoot, 'dist/client/settings.meta.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
await writeFile(outputPath, output);
console.log(
  `Client bundle: ${Buffer.byteLength(output)} bytes; ${bundledPackages.length} licensed dependencies; shared runtime imports: ${runtimeImports.join(', ')}`,
);
