/**
 * Reachability for every release at once.
 *
 * The question the tool exists to answer — "did this pull request survive into
 * the releases that followed?" — needs, for each commit, the set of releases
 * that contain it. Asking git once per (commit, release) pair is hopeless, so
 * we mark each release's tag commit with a bit and flood those bits backwards
 * through the parent edges in one pass.
 *
 * Requires `graph` in topological order, children before parents, which is what
 * `git log --topo-order` gives us: by the time a commit is visited, every child
 * has already contributed its bits.
 */
export function buildBitsets(graph, marks) {
  const n = marks.length;
  const W = Math.max(1, Math.ceil(n / 32));
  const shas = [...graph.keys()];
  const idx = new Map();
  for (let i = 0; i < shas.length; i++) idx.set(shas[i], i);

  const bits = new Uint32Array(shas.length * W);
  marks.forEach((m, b) => {
    const i = idx.get(m.sha);
    if (i === undefined) return;
    bits[i * W + (b >>> 5)] |= 1 << (b & 31);
  });

  for (let i = 0; i < shas.length; i++) {
    const base = i * W;
    let empty = true;
    for (let w = 0; w < W; w++) if (bits[base + w]) { empty = false; break; }
    if (empty) continue;
    for (const p of graph.get(shas[i]).parents) {
      const j = idx.get(p);
      if (j === undefined) continue;
      const pb = j * W;
      for (let w = 0; w < W; w++) bits[pb + w] |= bits[base + w];
    }
  }

  const has = (sha, b) => {
    const i = idx.get(sha);
    return i === undefined ? false : (bits[i * W + (b >>> 5)] & (1 << (b & 31))) !== 0;
  };
  const wordsOf = (sha) => {
    const i = idx.get(sha);
    return i === undefined ? null : bits.subarray(i * W, i * W + W);
  };
  return { W, count: n, has, wordsOf, order: shas };
}

export const bitOf = (words, b) => (words[b >>> 5] & (1 << (b & 31))) !== 0;

/** Indices marked on `sha`, excluding `self`. */
export function marksOn(bs, sha, self) {
  const w = bs.wordsOf(sha);
  const out = [];
  if (!w) return out;
  for (let b = 0; b < bs.count; b++) {
    if (b !== self && (w[b >>> 5] & (1 << (b & 31))) !== 0) out.push(b);
  }
  return out;
}
