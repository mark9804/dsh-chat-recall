import { lstat, realpath, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Only remove this repository's generated dist directory, never runtime index data. */
export async function cleanBuild(): Promise<void> {
  const root = await realpath(projectRoot);
  const target = resolve(root, 'dist');
  let entry;
  try {
    entry = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (await realpath(target)) !== target ||
    dirname(target) !== root
  ) {
    throw new Error(`Refusing to clean unexpected build path: ${target}`);
  }
  console.log(`Remove generated build: ${target}`);
  await rm(target, { recursive: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cleanBuild();
}
