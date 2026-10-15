export type AlignOp<T> =
  | { type: 'match'; a: T; b: T; ai: number; bi: number }
  | { type: 'sub'; a: T; b: T; ai: number; bi: number }
  /** Present in `a`, absent from `b`. */
  | { type: 'del'; a: T; ai: number }
  /** Present in `b`, absent from `a`. */
  | { type: 'ins'; b: T; bi: number };

/**
 * Needleman-Wunsch global alignment.
 *
 * `subCost` returns 0 for an exact match and up to 1 for unrelated items, which
 * lets near-misses align as substitutions instead of a delete/insert pair. A
 * `gapCost` below 0.5 therefore means two genuinely unrelated items prefer
 * delete+insert — the right answer when the speaker said a different word
 * rather than mangling the intended one.
 */
export function align<T>(
  a: readonly T[],
  b: readonly T[],
  subCost: (x: T, y: T) => number,
  gapCost = 0.48,
): AlignOp<T>[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const cost = new Float64Array((n + 1) * width);
  // 0 = diagonal, 1 = up (del), 2 = left (ins)
  const from = new Uint8Array((n + 1) * width);

  for (let j = 1; j <= m; j++) {
    cost[j] = j * gapCost;
    from[j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    cost[i * width] = i * gapCost;
    from[i * width] = 1;
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = cost[(i - 1) * width + (j - 1)] + subCost(a[i - 1], b[j - 1]);
      const up = cost[(i - 1) * width + j] + gapCost;
      const left = cost[i * width + (j - 1)] + gapCost;
      const here = i * width + j;
      if (diag <= up && diag <= left) {
        cost[here] = diag;
        from[here] = 0;
      } else if (up <= left) {
        cost[here] = up;
        from[here] = 1;
      } else {
        cost[here] = left;
        from[here] = 2;
      }
    }
  }

  const ops: AlignOp<T>[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const dir = i === 0 ? 2 : j === 0 ? 1 : from[i * width + j];
    if (dir === 0) {
      const x = a[i - 1];
      const y = b[j - 1];
      ops.push(
        subCost(x, y) === 0
          ? { type: 'match', a: x, b: y, ai: i - 1, bi: j - 1 }
          : { type: 'sub', a: x, b: y, ai: i - 1, bi: j - 1 },
      );
      i--;
      j--;
    } else if (dir === 1) {
      ops.push({ type: 'del', a: a[i - 1], ai: i - 1 });
      i--;
    } else {
      ops.push({ type: 'ins', b: b[j - 1], bi: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}

/** Levenshtein distance over code points, so æ/ø/å count as single characters. */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;

  let prev = new Uint32Array(y.length + 1);
  let curr = new Uint32Array(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;

  for (let i = 1; i <= x.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const sub = prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1);
      curr[j] = Math.min(sub, prev[j] + 1, curr[j - 1] + 1);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[y.length];
}

/** Edit distance scaled into 0–1 by the longer string. */
export function normalizedDistance(a: string, b: string): number {
  if (a === b) return 0;
  const longest = Math.max([...a].length, [...b].length);
  return longest === 0 ? 0 : editDistance(a, b) / longest;
}
