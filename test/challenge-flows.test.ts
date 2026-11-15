import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRuntime } from '../dist/host/plugin.js';
import type { HostContext, ToolDefinition } from '../dist/host/contracts.js';
import type { ReadResult } from '../dist/shared/model.js';
import type { SearchResult } from '../dist/storage/store.js';
import { toolUseChallenges } from './fixtures/tool-use-challenges.ts';
import type { ToolUseChallenge } from './fixtures/tool-use-challenges.ts';
import { nodeSubprocess } from './helpers/host.ts';

async function fixture(t: TestContext, challenge: ToolUseChallenge) {
  const tools = new Map<string, ToolDefinition>();
  const closes: (() => Promise<void>)[] = [];
  let sourceReads = 0;
  const id = challenge.header.id;
  const ctx: HostContext = {
    subprocess: nodeSubprocess(),
    sessions: { get: () => undefined },
    get: () => undefined,
    sessionQuery: {
      listSessions: async () => [{ header: challenge.header }],
      observeSession: async () => {
        throw new Error('Cold fixture must use query fallback');
      },
      readSession: async (target) => {
        assert.equal(target, id);
        return { session: challenge.header, inheritedEventCount: 0, events: challenge.events };
      },
      readEvent: async ({ sessionId, seq }) => {
        assert.equal(sessionId, id);
        const target = challenge.events.find((event) => event.seq === seq);
        assert.ok(target);
        sourceReads++;
        return { session: challenge.header, inheritedEventCount: 0, target };
      },
    },
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool);
      },
    },
    on: () => {},
    effect: (factory) => {
      closes.push(factory());
    },
  };
  applyRuntime(ctx, {
    nodePath: process.env.RECALL_TEST_NODE ?? process.execPath,
    dataPath: await mkdtemp(join(tmpdir(), 'dsh-recall-challenge-')),
    sessionIds: [id],
    embeddingSessionIds: [],
    callerSessionIds: [id],
    autoSync: false,
    dominantMin: 0.5,
    dominantGap: 0.15,
  });
  t.after(async () => {
    for (const close of closes) await close();
  });
  const call = async <T>(name: string, args: unknown): Promise<T> => {
    const tool = tools.get('chat_recall_' + name);
    assert.ok(tool);
    return (await tool.execute(args, { agent: { id }, signal: new AbortController().signal })) as T;
  };
  return { call, sourceReads: () => sourceReads };
}
type VerifiedRead = ReadResult & {
  verified: boolean;
  nextCursor: string | null;
};

// Exercise protocol behavior on synthetic data, not model judgment or answer quality.
test('search cursor visits every matching record and each citation is source verified', async (t) => {
  const { call, sourceReads } = await fixture(t, toolUseChallenges()[0]);
  const args = { query: '松岬巡检登记', mode: 'exact', scope: 'current', limit: 2 };
  let page = await call<SearchResult>('search', args);
  const seqs: number[] = [];
  let pages = 0;
  while (true) {
    pages++;
    assert.equal(page.hits.length, 2);
    for (const hit of page.hits) {
      seqs.push(hit.eventSeq);
      const read = await call<VerifiedRead>('read', {
        ref: hit.ref,
        blockIndex: hit.blockIndex,
        before: 0,
        after: 0,
      });
      assert.equal(read.verified, true);
      assert.equal(read.text, hit.excerpt);
    }
    if (!page.nextCursor) break;
    assert.ok(pages < 10, 'search pages must terminate');
    page = await call<SearchResult>('search', { ...args, cursor: page.nextCursor });
  }
  assert.ok(pages > 1);
  assert.deepEqual(seqs, [0, 2, 3, 4, 6, 7]);
  assert.equal(sourceReads(), 6);
});

test('read cursor rejects tampering without consuming continuation and reconstructs verified source', async (t) => {
  const challenge = toolUseChallenges()[1];
  const { call } = await fixture(t, challenge);
  const search = await call<SearchResult>('search', {
    query: '桔灯交接备忘',
    mode: 'exact',
    scope: 'current',
    limit: 2,
  });
  const hit = search.hits[0];
  let read = await call<VerifiedRead>('read', {
    ref: hit.ref,
    blockIndex: hit.blockIndex,
    length: 480,
    before: 0,
    after: 0,
  });
  assert.ok(read.nextCursor);
  const cursor = read.nextCursor;
  const tampered = (cursor[0] === 'a' ? 'b' : 'a') + cursor.slice(1);
  await assert.rejects(call('read', { cursor: tampered }), { code: 'INVALID_CURSOR' });
  // A rejected tampered value must not consume the original continuation.
  let text = '',
    pages = 0;
  while (true) {
    pages++;
    assert.equal(read.verified, true);
    assert.equal(read.offset, text.length);
    text += read.text;
    if (!read.nextCursor) break;
    assert.ok(pages < 10, 'read pages must terminate');
    read = await call<VerifiedRead>('read', { cursor: read.nextCursor });
  }
  const original = (challenge.events[0].data as { message: { content: { text: string }[] } })
    .message.content[0].text;
  assert.ok(pages > 1);
  assert.equal(text, original);
});
