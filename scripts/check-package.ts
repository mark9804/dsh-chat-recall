import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import type { Metafile } from 'esbuild';
import ts from 'typescript';

interface Notice {
  source: string;
  title: string;
  start: number;
  end: number;
  sha256: string;
}
interface ClientManifest {
  schemaVersion: number;
  moduleId: string;
  entryPoint: string;
  output: string;
  external: string[];
  runtimeImports: string[];
  bundleSha256: string;
  noticesSha256: string;
  metafile: Metafile;
  sourceNotices: Notice[];
  packages: {
    root: string;
    name: string;
    version: string;
    license: string;
    inputs: string[];
    notices: Notice[];
  }[];
}

const root = resolve(process.argv[2] ?? '.');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
  exports: { '.': { import: string }; './client': string };
  files: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
  dsh: { client: { platform: string; inject: string[] } };
};
const runtime = pkg.exports['.'].import;
const checked = new Set<string>();
const sharedRuntime = ['react', 'react-dom', 'react/jsx-runtime'].sort();
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const portable = (path: string): string => path.replaceAll('\\', '/').replace(/^\.\//, '');
const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean =>
  JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

async function visit(file: string): Promise<void> {
  file = resolve(file);
  if (checked.has(file)) return;
  checked.add(file);
  if (!file.startsWith(resolve(root, 'dist') + sep)) throw new Error('Runtime import escaped dist');
  const source = await readFile(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const statement of ast.statements) {
    const specifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    const spec = specifier.text;
    if (spec.startsWith('.')) await visit(resolve(dirname(file), spec));
    else if (spec.includes('lancedb') || spec === 'apache-arrow') {
      throw new Error(`Host imported native worker dependency: ${spec}`);
    }
  }
}
await visit(resolve(root, runtime));
const host = (await import(pathToFileURL(resolve(root, runtime)).href)) as {
  apply?: unknown;
  Config?: unknown;
};
if (typeof host.apply !== 'function' || typeof host.Config !== 'function') {
  throw new Error('Bad Host export');
}
await readFile(resolve(root, 'dist/worker/main.js'), 'utf8');
const client = await readFile(resolve(root, pkg.exports['./client']), 'utf8');
new Script(client, { filename: 'chat-recall-client.js' }); // Syntax only; never emulate the browser.
const ast = ts.createSourceFile(
  'settings.js',
  client,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
if (
  ast.statements.length !== 1 ||
  !ts.isExpressionStatement(ast.statements[0]) ||
  !ts.isCallExpression(ast.statements[0].expression)
) {
  throw new Error('Client must be one classic ModuleLoader registration.');
}
const loaderCall = ast.statements[0].expression;
const loader = loaderCall.expression;
if (
  !ts.isPropertyAccessExpression(loader) ||
  loader.name.text !== 'load' ||
  !ts.isPropertyAccessExpression(loader.expression) ||
  loader.expression.name.text !== '__ModuleLoader__' ||
  !ts.isIdentifier(loader.expression.expression) ||
  loader.expression.expression.text !== 'window' ||
  loaderCall.arguments.length !== 1 ||
  !ts.isObjectLiteralExpression(loaderCall.arguments[0])
) {
  throw new Error('Client must register with window.__ModuleLoader__.load.');
}
const registration = loaderCall.arguments[0];
const moduleId = registration.properties.find(
  (item) => ts.isPropertyAssignment(item) && item.name.getText(ast) === 'id',
);
const factory = registration.properties.find(
  (item) => ts.isMethodDeclaration(item) && item.name.getText(ast) === 'factory',
);
if (
  !moduleId ||
  !ts.isPropertyAssignment(moduleId) ||
  !ts.isStringLiteral(moduleId.initializer) ||
  moduleId.initializer.text !== 'dsh-chat-recall' ||
  !factory ||
  !ts.isMethodDeclaration(factory) ||
  !factory.body ||
  factory.parameters.length !== 1 ||
  !ts.isIdentifier(factory.parameters[0].name) ||
  factory.parameters[0].name.text !== 'require'
) {
  throw new Error('Invalid Client module id or CommonJS factory.');
}
const factoryRequire = factory.parameters[0].name;
const imports = new Set<string>();
let hasSettingsSection = false;
function inspectClient(node: ts.Node): void {
  if (ts.isStringLiteralLike(node) && node.text === 'settings.section') hasSettingsSection = true;
  if (
    ts.isImportDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    ts.isExportAssignment(node) ||
    (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
  ) {
    throw new Error('Unexpected Client ESM import/export.');
  }
  if (ts.isIdentifier(node) && node.text === 'require') {
    const parent = node.parent;
    if (ts.isCallExpression(parent) && parent.expression === node) {
      if (parent.arguments.length !== 1 || !ts.isStringLiteralLike(parent.arguments[0])) {
        throw new Error('Client runtime imports must be static string literals.');
      }
      imports.add(parent.arguments[0].text);
    } else if (node !== factoryRequire) {
      throw new Error('Client must not alias or dynamically access the shell require function.');
    }
  }
  ts.forEachChild(node, inspectClient);
}
inspectClient(ast);
if (!hasSettingsSection) throw new Error('Client does not register the settings factory.');
if ([...imports].some((id) => !sharedRuntime.includes(id))) {
  throw new Error(`Unexpected Client runtime imports: ${[...imports].join(', ')}`);
}
if (
  pkg.dsh.client.platform !== 'web' ||
  !pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings') ||
  !pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale')
) {
  throw new Error('Missing settings/locale Client activation dependencies.');
}

for (const [name, version] of Object.entries({
  '@base-ui/react': '1.9.0',
  '@types/react': '18.3.31',
  '@types/react-dom': '18.3.7',
  esbuild: '0.28.2',
  react: '18.3.1',
  'react-dom': '18.3.1',
})) {
  if (
    pkg.devDependencies[name] !== version ||
    pkg.dependencies?.[name] !== undefined ||
    pkg.optionalDependencies?.[name] !== undefined
  ) {
    throw new Error(`Client build-only dependency must be pinned in devDependencies: ${name}`);
  }
}
const noticesPath = 'dist/client/THIRD_PARTY_NOTICES.txt';
const manifestPath = 'dist/client/settings.meta.json';
for (const path of [
  portable(pkg.exports['./client']),
  noticesPath,
  manifestPath,
  'src/client/NOTICE.md',
  'src/client/SHADCN_LICENSE.txt',
]) {
  if (
    !pkg.files.some((entry) => {
      const included = portable(entry).replace(/\/$/, '');
      return path === included || path.startsWith(`${included}/`);
    })
  ) {
    throw new Error(`Package files omit required Client artifact or source notice: ${path}`);
  }
}
const notices = await readFile(resolve(root, noticesPath), 'utf8');
const manifest = JSON.parse(await readFile(resolve(root, manifestPath), 'utf8')) as ClientManifest;
if (
  manifest.schemaVersion !== 1 ||
  manifest.moduleId !== 'dsh-chat-recall' ||
  manifest.entryPoint !== 'src/client/settings.ts' ||
  manifest.output !== portable(pkg.exports['./client']) ||
  !sameSet(manifest.external, sharedRuntime) ||
  !sameSet(manifest.runtimeImports, imports) ||
  manifest.bundleSha256 !== hash(client) ||
  manifest.noticesSha256 !== hash(notices)
) {
  throw new Error('Client build provenance, runtime imports or artifact hashes do not match.');
}
const outputs = Object.entries(manifest.metafile.outputs);
if (outputs.length !== 1 || portable(outputs[0][0]) !== manifest.output) {
  throw new Error('Client metafile must contain only the classic JavaScript output.');
}
const recordedImports = outputs.flatMap(([, output]) =>
  output.imports.filter((item) => item.external).map((item) => item.path),
);
const inputImports = Object.values(manifest.metafile.inputs).flatMap((input) =>
  input.imports.filter((item) => item.external).map((item) => item.path),
);
if (
  !sameSet(recordedImports, imports) ||
  [...recordedImports, ...inputImports].some((path) => !sharedRuntime.includes(path))
) {
  throw new Error('Client metafile includes unexpected runtime externals.');
}

function packageName(input: string): string | undefined {
  const parts = portable(input).split('/');
  const index = parts.lastIndexOf('node_modules');
  if (index === -1) return undefined;
  const name = parts[index + 1];
  if (!name || name === '.pnpm' || (name.startsWith('@') && !parts[index + 2])) {
    throw new Error(`Cannot identify bundled dependency: ${input}`);
  }
  return name.startsWith('@') ? `${name}/${parts[index + 2]}` : name;
}
const bundledInputs = new Map<string, string>();
for (const input of Object.keys(manifest.metafile.inputs)) {
  const name = packageName(input);
  if (!name) continue;
  if (name === 'react' || name === 'react-dom') {
    throw new Error(`The shell-provided React runtime was bundled: ${input}`);
  }
  bundledInputs.set(input, name);
}
const seenSources = new Set<string>();
const spans: Notice[] = [];
function checkNotice(notice: Notice): string {
  const header = `=== ${notice.title} ===\nSource: ${notice.source}\n\n`;
  if (
    !Number.isSafeInteger(notice.start) ||
    !Number.isSafeInteger(notice.end) ||
    notice.start < header.length ||
    notice.end <= notice.start ||
    notice.end > notices.length ||
    seenSources.has(notice.source) ||
    notices.slice(notice.start - header.length, notice.start) !== header
  ) {
    throw new Error(`Missing or invalid bundled license/notice: ${notice.source}`);
  }
  const text = notices.slice(notice.start, notice.end);
  if (!text.trim() || hash(text) !== notice.sha256) {
    throw new Error(`Bundled license/notice is empty or changed: ${notice.source}`);
  }
  seenSources.add(notice.source);
  spans.push(notice);
  return text;
}
if (
  manifest.sourceNotices.length !== 2 ||
  !sameSet(
    manifest.sourceNotices.map((notice) => notice.source),
    ['src/client/NOTICE.md', 'src/client/SHADCN_LICENSE.txt'],
  )
) {
  throw new Error('Client source notices are incomplete.');
}
for (const notice of manifest.sourceNotices) {
  if (checkNotice(notice) !== (await readFile(resolve(root, notice.source), 'utf8'))) {
    throw new Error(`Bundled source notice differs from published source: ${notice.source}`);
  }
}
const coveredInputs = new Set<string>();
const packageRoots = new Set<string>();
for (const item of manifest.packages) {
  if (
    !item.name ||
    !item.version ||
    !item.license.trim() ||
    item.name === 'react' ||
    item.name === 'react-dom' ||
    packageRoots.has(item.root) ||
    packageName(item.root) !== item.name ||
    !resolve(root, item.root).startsWith(resolve(root, 'node_modules') + sep) ||
    !item.inputs.length
  ) {
    throw new Error(`Invalid bundled dependency provenance: ${item.name}`);
  }
  packageRoots.add(item.root);
  for (const input of item.inputs) {
    if (coveredInputs.has(input) || bundledInputs.get(input) !== item.name) {
      throw new Error(`Incorrect or duplicate bundled dependency attribution: ${input}`);
    }
    coveredInputs.add(input);
  }
  let hasLicense = false;
  for (const notice of item.notices) {
    const sourcePrefix = `${item.root}/`;
    const filename = notice.source.slice(sourcePrefix.length);
    if (
      !notice.source.startsWith(sourcePrefix) ||
      filename.includes('/') ||
      !/^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(filename)
    ) {
      throw new Error(`Invalid dependency notice source: ${notice.source}`);
    }
    checkNotice(notice);
    hasLicense ||= /^(?:licen[cs]e|copying)(?:$|[._-])/i.test(filename);
  }
  if (!hasLicense) throw new Error(`Missing bundled license: ${item.name}@${item.version}`);
}
if (
  !sameSet(coveredInputs, bundledInputs.keys()) ||
  !manifest.packages.some((item) => item.name === '@base-ui/react' && item.version === '1.9.0')
) {
  throw new Error('Client dependency license coverage is incomplete.');
}
spans.sort((a, b) => a.start - b.start);
if (spans.some((span, index) => index > 0 && span.start < spans[index - 1].end)) {
  throw new Error('Client license/notice sections overlap.');
}
console.log(
  JSON.stringify({
    entry: runtime,
    hostModules: checked.size,
    workerPresent: true,
    nativeFreeHost: true,
    clientFactory: true,
    settingsPage: true,
    sharedRuntimeImports: [...imports].sort(),
    bundledReact: false,
    licensedClientDependencies: manifest.packages.length,
    thirdPartyNotices: noticesPath,
  }),
);
