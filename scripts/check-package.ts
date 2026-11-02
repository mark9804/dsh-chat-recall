import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { Script } from 'node:vm';

const root = resolve(process.argv[2] ?? '.');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
  exports: { '.': { import: string }; './client': string };
  dsh: { client: { platform: string; inject: string[] } };
};
const runtime = pkg.exports['.'].import;
const checked = new Set<string>();

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
if (!client.includes('__ModuleLoader__.load') || !client.includes('settings.section')) {
  throw new Error('Client does not register the settings factory.');
}
if (
  pkg.dsh.client.platform !== 'web' ||
  !pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings')
) {
  throw new Error('Missing settings Client activation dependency.');
}
const imports = [...client.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
if (imports.some((id) => id !== 'react')) throw new Error('Unexpected Client runtime import.');
console.log(
  JSON.stringify({
    entry: runtime,
    hostModules: checked.size,
    workerPresent: true,
    nativeFreeHost: true,
    clientFactory: true,
    settingsPage: true,
  }),
);
