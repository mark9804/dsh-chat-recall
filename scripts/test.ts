import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cleanBuild, projectRoot } from './clean.ts';

const node = process.env.RECALL_TEST_NODE ?? process.execPath;
const tsc = resolve(projectRoot, 'node_modules/typescript/bin/tsc');
// Older supported Node 22 releases need this flag for the TypeScript child fixture.
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--experimental-strip-types']
  .filter(Boolean)
  .join(' ');

async function run(argv: string[]): Promise<void> {
  console.log(`Run: ${argv.join(' ')}`);
  await new Promise<void>((yes, no) => {
    const child = spawn(node, argv, { cwd: projectRoot, stdio: 'inherit' });
    child.once('error', no);
    child.once('close', (code, signal) => {
      if (code === 0) yes();
      else no(new Error(`Command failed (${signal ?? code}): ${argv[0]}`));
    });
  });
}

try {
  // Tests exercise emitted JS, but neither tests nor the working tree retain it.
  await run([tsc, '-p', 'tsconfig.json']);
  await run([tsc, '-p', 'tsconfig.test.json']);
  const tests = (await readdir(resolve(projectRoot, 'test')))
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => `test/${name}`);
  await run(['--experimental-strip-types', '--test', ...tests]);
  await run(['--experimental-strip-types', 'scripts/check-package.ts']);
} finally {
  await cleanBuild();
}
