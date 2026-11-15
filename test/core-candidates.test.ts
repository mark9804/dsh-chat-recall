import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseCandidates, type Candidate, type CandidatePolicy } from '../dist/core/candidates.js';

const hits = (scores: number[]) =>
  scores.map((similarity, index) => ({
    ref: `synthetic-${index}`,
    similarity,
    text: `body-${index}`,
  }));

test('a dominant semantic candidate displays one body while comparing three refs', () => {
  const result = chooseCandidates(hits([0.8, 0.5, 0.45, 0.4]));
  assert.equal(result.count, 1);
  assert.equal(result.policy, 'semantic-dominant');
  assert.deepEqual(result.comparison, {
    scoreType: 'cosine-similarity',
    top3: [
      { ref: 'synthetic-0', score: 0.8 },
      { ref: 'synthetic-1', score: 0.5 },
      { ref: 'synthetic-2', score: 0.45 },
    ],
    gap12: 0.8 - 0.5,
    dominantMin: 0.5,
    dominantGap: 0.15,
  });
  assert.equal(JSON.stringify(result.comparison).includes('body-'), false);
});

test('dominance requires three candidates, minimum similarity, and sufficient gap', () => {
  assert.equal(chooseCandidates(hits([0.9, 0.1])).count, 2);
  assert.equal(chooseCandidates(hits([0.49, 0.1, 0.09])).count, 3);
  assert.equal(chooseCandidates(hits([0.9, 0.8, 0.5])).count, 3);
  assert.equal(chooseCandidates(hits([0.5, 0.35, 0.1])).count, 1);
  assert.equal(chooseCandidates(hits([0.6, 0.45, 0.1])).count, 1, 'decimal threshold boundary');
  assert.equal(chooseCandidates(hits([0.6, 0.46, 0.1])).count, 3);
});

test('three-to-five choice compares each extra candidate to third, not to neighbors', () => {
  assert.equal(chooseCandidates(hits([0.8, 0.75, 0.7, 0.61, 0.6])).count, 3);
  assert.equal(chooseCandidates(hits([0.8, 0.75, 0.7, 0.65, 0.6])).count, 4);
  assert.equal(chooseCandidates(hits([0.8, 0.75, 0.7, 0.65, 0.62, 0.61])).count, 5);
  assert.equal(chooseCandidates(hits([0.4, 0.4, 0.4, 0.4, 0.4, 0.4])).count, 5);
  assert.equal(chooseCandidates(hits([0.8, 0.75, 0.7, 0.7]), { closeGap: 0 }).count, 4);
});

test('threshold overrides are reported and change only display policy', () => {
  const result = chooseCandidates(hits([0.45, 0.2, 0.1]), { dominantMin: 0.4, dominantGap: 0.2 });
  assert.equal(result.count, 1);
  assert.equal(result.comparison.dominantMin, 0.4);
  assert.equal(result.comparison.dominantGap, 0.2);
  assert.equal(chooseCandidates(hits([0.8, 0.75, 0.7, 0.6, 0.5]), { closeGap: 0.2 }).count, 5);
});

test('zero, one and two candidates are reported truthfully, including low similarities', () => {
  for (const scores of [[], [-0.8], [-0.5, -0.9]]) {
    const result = chooseCandidates(hits(scores));
    assert.equal(result.count, scores.length);
    assert.equal(result.policy, 'semantic-insufficient');
    assert.equal(result.comparison.top3.length, scores.length);
    if (scores.length < 2) assert.equal(result.comparison.gap12, null);
  }
  assert.equal(chooseCandidates(hits([-0.5, -0.6, -0.7, -0.75])).count, 4);
});

test('explicit limits 1..20 override dominance and automatic minimums', () => {
  assert.equal(chooseCandidates(hits([0.99, 0.1, 0.09, 0.08]), { limit: 3 }).count, 3);
  assert.equal(chooseCandidates(hits([0.6, 0.59, 0.58]), { limit: 1 }).count, 1);
  assert.equal(chooseCandidates(hits([0.6, 0.59, 0.58]), { limit: 20 }).count, 3);
  assert.equal(chooseCandidates(hits([]), { limit: 1 }).count, 0);
  assert.equal(chooseCandidates(hits([0.5, 0.4, 0.3]), { limit: 2 }).policy, 'explicit-limit');
  for (const limit of [0, 21, -1, 1.5, NaN, null])
    assert.throws(() => chooseCandidates([], { limit: limit as unknown as number }), RangeError);
});

test('exact and fuzzy use limits only, without probability or dominance decisions', () => {
  const exact = Array.from({ length: 8 }, (_, i) => ({ ref: `exact-${i}` }));
  const result = chooseCandidates(exact, { mode: 'exact' });
  assert.equal(result.count, 5);
  assert.equal(result.policy, 'mode-default');
  assert.equal(result.comparison.scoreType, 'exact');
  assert.equal(result.comparison.gap12, null);
  assert.deepEqual(result.comparison.top3[0], { ref: 'exact-0', score: 1 });
  const fuzzy = exact.map((hit, index) => ({
    ...hit,
    coverage: 1 - index / 10,
    bm25: 300 - index * 40,
  }));
  const fuzzyResult = chooseCandidates(fuzzy, { mode: 'fuzzy' });
  assert.equal(fuzzyResult.count, 5);
  assert.equal(fuzzyResult.comparison.scoreType, 'bm25-coverage');
  assert.equal(fuzzyResult.comparison.gap12, null);
  assert.deepEqual(fuzzyResult.comparison.top3[0].score, { coverage: 1, bm25: 300 });
  assert.equal(chooseCandidates(fuzzy, { mode: 'fuzzy', limit: 2 }).count, 2);
  assert.equal(chooseCandidates(exact, { mode: 'exact', limit: 20 }).count, 8);
});

test('selection never sorts, mutates or reads candidate bodies', () => {
  const candidates = hits([0.8, 0.75, 0.7, 0.65]);
  for (const hit of candidates) {
    Object.defineProperty(hit, 'text', {
      get() {
        throw new Error('body must not be read');
      },
    });
    Object.freeze(hit);
  }
  Object.freeze(candidates);
  assert.equal(chooseCandidates(candidates).count, 4);
  assert.deepEqual(
    chooseCandidates(candidates).comparison.top3.map((hit) => hit.ref),
    candidates.slice(0, 3).map((hit) => hit.ref),
  );
});

test('semantic scores and options are validated without interpreting BM25 as similarity', () => {
  assert.throws(() => chooseCandidates([{ score: 99 }]), TypeError);
  assert.throws(() => chooseCandidates(hits([NaN])), TypeError);
  assert.throws(() => chooseCandidates(hits([Infinity])), TypeError);
  assert.throws(() => chooseCandidates([], { dominantGap: -1 }), RangeError);
  assert.throws(() => chooseCandidates([], { dominantMin: 2 }), RangeError);
  assert.throws(() => chooseCandidates([], { closeGap: NaN }), RangeError);
  assert.throws(
    () => chooseCandidates([], { mode: 'bm25' as unknown as CandidatePolicy['mode'] }),
    RangeError,
  );
  assert.throws(() => chooseCandidates(null as unknown as Candidate[]), TypeError);
});
