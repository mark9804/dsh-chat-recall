export const CHUNKING_VERSION = 'paragraph-v1';

/** A verbatim text range measured in UTF-16 code units. */
export interface Chunk {
  start: number;
  end: number;
  text: string;
}

/** Chunk sizes are measured in Unicode codepoints, not UTF-16 units. */
export interface ChunkOptions {
  target?: number;
  minTail?: number;
}

/**
 * Prefer paragraph breaks, then sentence/newline boundaries, then a hard cut.
 * Preserve delimiters and reserve a final tail; no chunk exceeds target + minTail.
 */
export function chunkText(
  text: string,
  { target = 600, minTail = 120 }: ChunkOptions = {},
): Chunk[] {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (!Number.isSafeInteger(target) || target < 1) {
    throw new RangeError('target must be a positive integer');
  }
  if (!Number.isSafeInteger(minTail) || minTail < 0 || !Number.isSafeInteger(target + minTail)) {
    throw new RangeError('minTail must be a non-negative integer within the safe size range');
  }
  if (!text.length) return [];

  const offsets = [0];
  const pointAt = new Map([[0, 0]]);
  for (const point of text) {
    // The initial zero keeps the offset array nonempty.
    const offset = offsets.at(-1)! + point.length;
    offsets.push(offset);
    pointAt.set(offset, offsets.length - 1);
  }
  const length = offsets.length - 1;
  const boundaries = new Uint8Array(length + 1);
  for (const match of text.matchAll(/[.!?。！？；;]+[”’"'»）)\]】]*[ \t]*|\r\n|[\r\n]/gu)) {
    // Unicode regex matches end on codepoint boundaries recorded above.
    boundaries[pointAt.get(match.index + match[0].length)!] = 1;
  }
  for (const match of text.matchAll(
    /(?:\r?\n|\r(?!\n))[ \t]*(?:\r?\n|\r(?!\n))(?:[ \t]*(?:\r?\n|\r(?!\n)))*/gu,
  )) {
    boundaries[pointAt.get(match.index + match[0].length)!] = 2;
  }

  const maximum = target + minTail;
  const tailFloor = Math.min(minTail, target);
  const lowerSize = Math.max(1, tailFloor, Math.floor(target / 2));
  const result: Chunk[] = [];
  let start = 0;
  while (start < length) {
    let end = length;
    if (length - start > maximum) {
      const lower = start + lowerSize;
      const upper = Math.min(start + maximum, length - tailFloor);
      const ideal = start + target;
      let best = -1;
      for (let candidate = lower; candidate <= upper; candidate++) {
        if (!boundaries[candidate]) continue;
        if (
          best < 0 ||
          boundaries[candidate] > boundaries[best] ||
          (boundaries[candidate] === boundaries[best] &&
            Math.abs(candidate - ideal) < Math.abs(best - ideal))
        ) {
          best = candidate;
        }
      }
      end = best < 0 ? ideal : best;
    }
    const from = offsets[start];
    const to = offsets[end];
    result.push({ start: from, end: to, text: text.slice(from, to) });
    start = end;
  }
  return result;
}
