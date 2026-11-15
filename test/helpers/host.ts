import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SubprocessService } from '../../dist/host/contracts.js';

export function nodeSubprocess(): SubprocessService & {
  children: ChildProcessWithoutNullStreams[];
} {
  const children: ChildProcessWithoutNullStreams[] = [];
  return {
    children,
    resolveExecutable: async (value) => value,
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Do not inherit API keys, env-file options or other runtime credentials.
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
      children.push(child);
      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject);
          child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
        },
      );
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        done,
        terminate: () => child.kill('SIGTERM'),
        waitForExit: async () => {
          await done;
          return true;
        },
      };
    },
  };
}
