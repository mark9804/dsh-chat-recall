import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const nodePath = process.env.RECALL_TEST_NODE ?? process.execPath;

for (const params of [undefined, null]) {
  test(`worker requires one configuration and treats params=${String(params)} as empty`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-worker-protocol-'));
    const child = spawn(nodePath, ['dist/worker/main.js', root], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const done = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    try {
      const readyLine = await lines.next();
      assert.equal(readyLine.done, false);
      const ready = JSON.parse(readyLine.value as string) as { type: string };
      assert.equal(ready.type, 'ready');
      const requests = [
        { id: 1, method: 'status' },
        { id: 2, method: 'configure', ...(params === undefined ? {} : { params }) },
        { id: 3, method: 'configure' },
      ];
      // Queue these together to verify ordering at the real JSONL boundary.
      child.stdin.write(requests.map((request) => JSON.stringify(request)).join('\n') + '\n');
      for (const expected of [
        { id: 1, ok: false, error: { code: 'NOT_PREPARED' } },
        { id: 2, ok: true, value: { configured: true } },
        { id: 3, ok: false, error: { code: 'INVALID_REQUEST' } },
      ]) {
        const line = await lines.next();
        assert.equal(line.done, false);
        const result = JSON.parse(line.value as string) as {
          id: number;
          ok: boolean;
          value?: unknown;
          error?: { code: string };
        };
        assert.equal(result.id, expected.id);
        assert.equal(result.ok, expected.ok);
        if (expected.error) assert.equal(result.error?.code, expected.error.code);
        else assert.deepEqual(result.value, expected.value);
      }
    } finally {
      child.stdin.end();
      assert.equal(await done, 0);
    }
  });
}
