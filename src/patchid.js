import * as G from './git.js';

const MAX_INNER = 100; // a "PR" bigger than this is a branch sync, not a change

/** Run `fn` over `items`, `n` at a time. */
async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/**
 * Find pull requests whose change reached a target under another commit — a
 * backport whose title was reworded, or that names its original without a "#".
 *
 * A PR has arrived at a target when its whole diff has (a squash against a
 * merge, or the reverse), or when every commit it brought in has. Hashing every
 * commit on the trunk costs 7–25s on a large repo, so only commits touching
 * exactly the same paths as a candidate are hashed.
 *
 * Returns Map pr -> Uint32Array of the target bits it was found at.
 */
export async function patchEquivalents(cwd, graph, bs, prs, targetBits, targetRefs, since) {
  const found = new Map();
  if (!prs.length) return found;

  // the commits each merge-style PR brought in
  const inner = new Map();
  await pool(prs.filter((pr) => pr.style === 'merge'), 8, async (pr) => {
    const c = graph.get(pr.sha);
    if (!c || c.parents.length !== 2) return;
    const out = await G.git(cwd, ['rev-list', '--no-merges', `--max-count=${MAX_INNER + 1}`, c.parents[1], '^' + c.parents[0]], { allowFail: true });
    const shas = out.split('\n').filter(Boolean);
    if (shas.length && shas.length <= MAX_INNER) inner.set(pr, shas);
  });

  const mine = new Set();
  for (const pr of prs) {
    mine.add(pr.sha);
    for (const s of inner.get(pr) || []) mine.add(s);
  }

  // Equal patch-ids need equal sets of touched paths, which a tree comparison
  // finds without diffing any content: hash only the target commits that
  // touch exactly the paths some candidate does.
  const [minePaths, targetPaths] = await Promise.all([
    G.changedPaths(cwd, { shas: [...mine] }),
    G.changedPaths(cwd, { refs: targetRefs, since }),
  ]);
  const wanted = new Set([...minePaths.values()].filter(Boolean));
  const theirs = [];
  for (const [sha, key] of targetPaths) {
    // a candidate's own commits stay in: one already on a target counts there
    if (wanted.has(key) && targetBits.some((b) => bs.has(sha, b))) theirs.push(sha);
  }

  const ours = await G.patchIds(cwd, [...mine]);
  const other = await G.patchIds(cwd, theirs.filter((s) => !ours.has(s)));
  for (const s of theirs) if (ours.has(s)) other.set(s, ours.get(s));
  const where = new Map(); // patch-id -> target bits
  for (const [sha, id] of other) {
    const words = bs.wordsOf(sha);
    if (!words) continue;
    let acc = where.get(id);
    if (!acc) { acc = new Uint32Array(bs.W); where.set(id, acc); }
    for (const b of targetBits) if (bs.has(sha, b)) acc[b >>> 5] |= 1 << (b & 31);
  }

  for (const pr of prs) {
    const acc = new Uint32Array(bs.W);
    const whole = where.get(ours.get(pr.sha));
    if (whole) for (let w = 0; w < bs.W; w++) acc[w] |= whole[w];
    const shas = inner.get(pr);
    if (shas) {
      // every commit must have arrived at the same target
      let all = null;
      for (const s of shas) {
        const w = where.get(ours.get(s));
        if (!w) { all = null; break; }
        if (!all) all = Uint32Array.from(w);
        else for (let i = 0; i < bs.W; i++) all[i] &= w[i];
      }
      if (all) for (let w = 0; w < bs.W; w++) acc[w] |= all[w];
    }
    if (acc.some((w) => w)) found.set(pr, acc);
  }
  return found;
}
