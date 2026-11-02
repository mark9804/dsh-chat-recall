import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

// NodeNext adds an empty ESM marker for type-only imports. DSH loads this
// self-contained ModuleLoader factory as a classic script, not an ESM module.
const path = resolve('dist/client/settings.js');
let source = await readFile(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const emptyExports: ts.Statement[] = [];
for (const statement of ast.statements) {
  if (
    ts.isExportDeclaration(statement) &&
    !statement.moduleSpecifier &&
    statement.exportClause &&
    ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.length === 0
  ) {
    emptyExports.push(statement);
    continue;
  }
  if (
    ts.isImportDeclaration(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isExportAssignment(statement) ||
    (ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
  ) {
    throw new Error(
      'Client entry must be one factory with type-only imports; runtime ESM is unsupported.',
    );
  }
}
// Keep line positions intact for the TypeScript source map.
for (const statement of emptyExports.reverse()) {
  source =
    source.slice(0, statement.getStart(ast)) +
    source.slice(statement.getStart(ast), statement.end).replace(/[^\r\n]/g, ' ') +
    source.slice(statement.end);
}
await writeFile(path, source);
console.log('Built DSH client factory: dist/client/settings.js');
