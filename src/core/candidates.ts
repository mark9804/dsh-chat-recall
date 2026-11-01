import type { SearchMode } from '../shared/model.js';

const CANDIDATE_NOTICE =
  'Candidates only: similarity ranks candidates, not the probability of correctness or a relevance verdict. Low scores do not establish that no answer exists.';

/** Only ranking fields are needed; candidate bodies are never inspected. */
export interface Candidate {
  ref?: string;
  id?: string;
  similarity?: number;
  score?: number;
  coverage?: number;
  bm25?: number;
}

/** Display policy for already-ranked, source-deduplicated candidates. */
export interface CandidatePolicy {
  mode?: SearchMode;
  limit?: number;
  dominantMin?: number;
  dominantGap?: number;
  closeGap?: number;
}

export interface CandidateFuzzyScore {
  coverage: number | null;
  bm25: number | null;
}

export interface CandidateScore {
  ref: string | null;
  score: number | CandidateFuzzyScore;
}

export interface CandidateComparison {
  scoreType: 'cosine-similarity' | 'exact' | 'bm25-coverage';
  top3: CandidateScore[];
  gap12: number | null;
  dominantMin: number;
  dominantGap: number;
}

/** Summary metadata does not consume or reorder displayed candidate bodies. */
export interface CandidatePresentation {
  count: number;
  policy:
    | 'explicit-limit'
    | 'mode-default'
    | 'semantic-insufficient'
    | 'semantic-dominant'
    | 'semantic-close';
  comparison: CandidateComparison;
  notice: string;
}

/** Select how many already-ranked, source-deduplicated candidates to display. */
export function chooseCandidates(
  hits: readonly Candidate[],
  {
    mode = 'semantic',
    limit,
    dominantMin = 0.5,
    dominantGap = 0.15,
    closeGap = 0.08,
  }: CandidatePolicy = {},
): CandidatePresentation {
  if (!Array.isArray(hits)) throw new TypeError('hits must be an array');
  if (!['semantic', 'exact', 'fuzzy'].includes(mode)) {
    throw new RangeError('mode must be semantic, exact or fuzzy');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 20)) {
    throw new RangeError('limit must be an integer from 1 to 20');
  }
  if (
    !Number.isFinite(dominantMin) ||
    dominantMin < -1 ||
    dominantMin > 1 ||
    !Number.isFinite(dominantGap) ||
    dominantGap < 0 ||
    dominantGap > 2 ||
    !Number.isFinite(closeGap) ||
    closeGap < 0 ||
    closeGap > 2
  ) {
    throw new RangeError('similarity thresholds must be finite and within cosine score/gap bounds');
  }
  if (mode === 'semantic' && hits.some((hit) => !Number.isFinite(hit?.similarity))) {
    throw new TypeError('semantic hits require finite similarity scores');
  }

  const scoreType =
    mode === 'semantic' ? 'cosine-similarity' : mode === 'exact' ? 'exact' : 'bm25-coverage';
  const top3: CandidateScore[] = hits.slice(0, 3).map((hit) => ({
    ref: hit.ref ?? hit.id ?? null,
    score:
      mode === 'semantic'
        ? hit.similarity!
        : mode === 'exact'
          ? (hit.score ?? 1)
          : { coverage: hit.coverage ?? null, bm25: hit.bm25 ?? null },
  }));
  // Semantic scores were validated above; other modes never subtract scores.
  const gap12 =
    mode === 'semantic' && top3.length > 1
      ? (top3[0].score as number) - (top3[1].score as number)
      : null;
  const comparison: CandidateComparison = { scoreType, top3, gap12, dominantMin, dominantGap };
  let count: number;
  let policy: CandidatePresentation['policy'];
  if (limit !== undefined) {
    count = Math.min(hits.length, limit);
    policy = 'explicit-limit';
  } else if (mode !== 'semantic') {
    count = Math.min(hits.length, 5);
    policy = 'mode-default';
  } else if (hits.length < 3) {
    count = hits.length;
    policy = 'semantic-insufficient';
  } else if (hits[0].similarity! >= dominantMin && gap12! >= dominantGap - Number.EPSILON) {
    count = 1;
    policy = 'semantic-dominant';
  } else {
    count = 3;
    while (
      count < Math.min(5, hits.length) &&
      hits[2].similarity! - hits[count].similarity! <= closeGap + Number.EPSILON
    ) {
      count++;
    }
    policy = 'semantic-close';
  }
  return {
    count,
    policy,
    comparison,
    notice:
      mode === 'semantic'
        ? CANDIDATE_NOTICE
        : 'Candidates only: exact matches and BM25/coverage rankings are not semantic probabilities or correctness judgments.',
  };
}
