import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDocs = [
  'README.md',
  'docs/architecture.md',
  'docs/development.md',
  'docs/api.md',
  'evaluation/README.md',
  'test/fixtures/README.md',
  'src/client/NOTICE.md',
];
const mainDocs = ['api.md', 'architecture.md', 'development.md'];
assert.deepEqual((await readdir(resolve(root, 'docs'))).sort(), mainDocs);
assert.deepEqual((await readdir(resolve(root, 'evaluation'))).sort(), [
  'README.md',
  'queries.json',
]);

// A narrow public-surface check, not a claim to detect every secret or erase Git
// history. It does not read environment files, indexes or private run artifacts.
const privateIdentifier =
  /\/Users\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\|session-[0-9a-f]{8}-[0-9a-f-]{27,}|\bsk-[A-Za-z0-9_-]{16,}\b/giu;
function headings(text: string): Set<string> {
  const result = new Set<string>();
  const counts = new Map<string, number>();
  const withoutCode = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  for (const match of withoutCode.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1]!
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*_~]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '')
      .replace(/\s/g, '-');
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    result.add(n ? `${base}-${n}` : base);
  }
  return result;
}
let links = 0;
for (const file of publicDocs) {
  const text = await readFile(resolve(root, file), 'utf8');
  privateIdentifier.lastIndex = 0;
  assert.equal(
    privateIdentifier.test(text),
    false,
    `Private identifier in public document: ${file}`,
  );
  assert.doesNotMatch(text, /private-docs-|待打包|逐轮验收/gu, file);
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) {
    const destination = match[1] ?? match[2]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(destination)) {
      assert.ok(/^(?:https?:|mailto:)/i.test(destination), `Non-public URL in ${file}`);
      continue;
    }
    const hash = destination.indexOf('#');
    const path = decodeURIComponent(hash < 0 ? destination : destination.slice(0, hash));
    const fragment = hash < 0 ? '' : decodeURIComponent(destination.slice(hash + 1));
    const target = path ? resolve(root, dirname(file), path) : resolve(root, file);
    const rel = relative(root, target);
    assert.ok(
      !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'),
      `Link escapes repository: ${file}`,
    );
    assert.ok(
      !rel.split(/[\\/]/).some((part) => part.startsWith('.') || part === 'node_modules'),
      `Private link target: ${file}`,
    );
    const info = await stat(target);
    if (fragment && info.isFile()) {
      const content = await readFile(target, 'utf8');
      if (/^L\d+(?:-L\d+)?$/u.test(fragment)) {
        const numbers = fragment.match(/\d+/g)!.map(Number);
        assert.ok(
          numbers[0]! >= 1 && numbers.at(-1)! <= content.split('\n').length,
          `Invalid source line: ${destination}`,
        );
      } else if (target.endsWith('.md')) {
        assert.ok(headings(content).has(fragment), `Missing heading: ${file} -> ${destination}`);
      }
    }
    links++;
  }
}
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
  files: string[];
};
for (const file of ['README.md', ...mainDocs.map((name) => `docs/${name}`)])
  assert.ok(manifest.files.includes(file), `Missing published document: ${file}`);
assert.ok(
  !manifest.files.some((file) => /^(?:evaluation|test|\.benchmark|\.env)(?:\/|$)/.test(file)),
  'Private/evaluation inputs must not enter the installation package',
);
const queries = await readFile(resolve(root, 'evaluation/queries.json'), 'utf8');
privateIdentifier.lastIndex = 0;
assert.equal(
  privateIdentifier.test(queries),
  false,
  'Private identifier in public diagnostic inputs',
);
assert.ok(!('createdAt' in JSON.parse(queries)), 'Diagnostic input metadata is not a run diary');
console.log(
  JSON.stringify({
    publicDocuments: publicDocs.length,
    checkedRelativeLinks: links,
    mainDocuments: 4,
    privateIdentifierCheck: 'bounded',
  }),
);
