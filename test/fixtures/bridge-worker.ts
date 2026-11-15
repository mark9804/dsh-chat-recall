import { createInterface } from 'node:readline';

// No native modules, network, env files, or filesystem writes are needed by this fixture.
const mode = process.argv[2];
const timers = new Set<ReturnType<typeof setTimeout>>();
const keepAlive = mode === 'ignore-close' ? setInterval(() => {}, 1_000) : null;
const input = createInterface({ input: process.stdin });
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const later = (callback: () => void, delay: number) => {
  const timer = setTimeout(() => {
    timers.delete(timer);
    callback();
  }, delay);
  timers.add(timer);
};
const ready = () =>
  write({
    type: 'ready',
    protocol: 1,
    pid: process.pid,
    node: process.version,
    lancedb: '0.0.0-fixture',
    ignored: 'fixture-private-value',
  });

if (mode === 'bad-ready') write({ type: 'ready', protocol: 9 });
else if (mode === 'exit-before-ready') process.exit(12);
else if (mode === 'no-ready') {
  /* Wait on stdin until the bridge terminates us. */
} else if (mode === 'slow-ready') later(ready, 200);
else ready();

input.on('line', (line) => {
  const { id, method, params } = JSON.parse(line) as {
    id: number;
    method: string;
    params: unknown;
  };
  switch (method) {
    case 'echo':
      write({ id, ok: true, value: params });
      break;
    case 'runtime':
      write({
        id,
        ok: true,
        value: { executable: process.execPath, version: process.version, dataPath: mode },
      });
      break;
    case 'delay': {
      const delayed = params as { value: unknown; ms: number };
      later(() => write({ id, ok: true, value: delayed.value }), delayed.ms);
      break;
    }
    case 'hang':
      break;
    case 'fragment': {
      const bytes = Buffer.from(
        `${JSON.stringify({ id, ok: true, value: '你好，鲸鱼 🐳 café' })}\n`,
      );
      for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
      break;
    }
    case 'fail':
      process.stderr.write('fixture-private-value\n');
      write({
        id,
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'fixture-private-value',
          cause: 'fixture-private-value',
        },
      });
      break;
    case 'bad-error':
      write({
        id,
        ok: false,
        error: { code: 'fixture-private-value', message: 'fixture-private-value' },
      });
      break;
    case 'uppercase-secret':
      write({
        id,
        ok: false,
        error: { code: 'PRIVATE_CREDENTIAL', message: 'fixture-private-value' },
      });
      break;
    case 'stderr':
      for (let index = 0; index < 128; index++)
        process.stderr.write('fixture-private-value'.repeat(1_024));
      write({ id, ok: true, value: 'drained' });
      break;
    case 'exit':
      process.exit(13);
      break;
    case 'eof':
      process.stdout.end();
      break;
    case 'malformed':
      process.stdout.write('not-json: fixture-private-value\n');
      break;
    case 'partial-eof':
      process.stdout.write('{"id":');
      process.stdout.end();
      break;
    default:
      write({ id, ok: false, error: { code: 'UNKNOWN_METHOD', message: 'Unknown method.' } });
  }
});

input.on('close', () => {
  for (const timer of timers) clearTimeout(timer);
  if (!keepAlive) process.exitCode = 0;
});
