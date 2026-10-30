import * as G from './git.js';
import { buildBitsets, bitOf, marksOn } from './lineage.js';
import { patchEquivalents } from './patchid.js';

const SEMVER = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-.]([0-9A-Za-z][0-9A-Za-z.-]*))?$/;
const RELEASE_BRANCH = /^(release|hotfix|support)[/-](.+)$/i;
// Maintenance lines named for the version alone: v4, v3.1, 1.9.x, stable/5.0.x
const LINE_BRANCH = /^(?:(?:stable|maint(?:enance)?)[/-])?(v\d+(?:\.\d+)?(?:\.x)?|\d+\.(?:\d+(?:\.x)?|x))$/i;
const INTEGRATION = ['develop', 'development', 'main', 'master', 'trunk'];

export function parseVersion(name) {
  const m = SEMVER.exec(name.trim());
  if (!m) return null;
  return {
    major: +m[1],
    minor: +m[2],
    patch: m[3] === undefined ? 0 : +m[3],
    pre: m[4] || '',
  };
}

/** Ascending: 1.8.0-rc.1 < 1.8.0 < 1.8.1 < 2.0.0 */
export function compareVersion(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const pa = a.pre.split('.');
  const pb = b.pre.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (+x !== +y) return +x - +y;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function versionLabel(v) {
  return `${v.major}.${v.minor}.${v.patch}${v.pre ? '-' + v.pre : ''}`;
}

/**
 * Pull a pull-request out of a commit subject/body. Handles the three shapes that
 * cover almost every repo: GitHub merge commits, GitHub squash merges, Bitbucket.
 */
export function parsePR(commit) {
  const s = commit.subject || '';
  let m = /^Merge pull request #(\d+) from (\S+)/.exec(s);
  if (m) {
    return { number: +m[1], title: (commit.body || '').trim() || m[2], head: m[2], style: 'merge' };
  }
  m = /^Merged in (\S+) \(pull request #(\d+)\)/.exec(s);
  if (m) {
    return { number: +m[2], title: (commit.body || '').trim() || m[1], head: m[1], style: 'merge' };
  }
  m = /^(.*)\s\(#(\d+)\)\s*$/.exec(s);
  if (m) {
    return { number: +m[2], title: m[1].trim(), head: null, style: 'squash' };
  }
  return null;
}

/**
 * A PR title reduced to what survives a backport: "[release-3.5] fix x (#13003)",
 * "release-3.5: fix x" and "fix x [backport to v4]" all become "fix x".
 */
export function normTitle(s) {
  return (s || '').toLowerCase()
    .replace(/\s*\(#\d+\)\s*$/, '')
    .replace(/^(?:\[[^\]]*\]\s*:?\s*|(?:(?:release|backport)[- ]?)?v?\d+\.\d+(?:\.x)?:\s*|backport:\s*)+/, '')
    .replace(/\s*[[(](?:backport|cherry[- ]?pick|release|v?\d+\.\d+)[^\])]*[\])]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Too generic to say two commits are the same change.
const GENERIC_TITLE = /^(?:merge\b|release\b|bump version|chore(?:\([^)]*\))?: (?:release|bump)|v?\d)/;
const matchableTitle = (t) => t.length >= 15 && !GENERIC_TITLE.test(t);

const SYNC = /^Merge (?:remote-tracking )?branch '[^']+'(?: of \S+)?(?: into \S+)?$/;

/** Every PR number mentioned anywhere in a commit — used for the "landed elsewhere" fallback. */
function prMentions(commit, out) {
  const pr = parsePR(commit);
  if (pr) out.add(pr.number);
  const s = commit.subject || '';
  let m;
  const re = /#(\d+)/g;
  while ((m = re.exec(s))) out.add(+m[1]);
}

/** Walk parents from `tips`, collecting every reachable sha present in `graph`. */
function reachable(graph, tips) {
  const seen = new Set();
  const stack = tips.filter((t) => graph.has(t));
  for (const t of stack) seen.add(t);
  while (stack.length) {
    const c = graph.get(stack.pop());
    for (const p of c.parents) {
      if (!seen.has(p) && graph.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return seen;
}

export async function build(cwd, opts) {
  const remote = opts.remote;
  const notes = [];

  const [allTags, branches, headBranch] = await Promise.all([
    G.listTags(cwd),
    G.listBranches(cwd, remote),
    G.defaultBranch(cwd, remote),
  ]);

  const byName = new Map(branches.map((b) => [b.name, b]));

  // --- integration branches (auto-detected git-flow) -----------------------
  let integration = opts.integration;
  if (!integration || !integration.length) {
    integration = INTEGRATION.filter((n) => byName.has(n));
    if (headBranch && byName.has(headBranch) && !integration.includes(headBranch)) integration.unshift(headBranch);
    if (!integration.length && branches.length) integration = [branches[0].name];
  } else {
    integration = integration.filter((n) => {
      if (byName.has(n)) return true;
      notes.push(`branch "${n}" not found on ${remote}, ignored`);
      return false;
    });
  }
  if (!integration.length) throw new Error('No integration branch found. Pass --branches develop,master');

  // The "trunk" (where work accumulates) and the "prod" line (where releases land).
  const trunk = integration.find((n) => /^dev/.test(n)) || integration[0];
  const prod = integration.find((n) => /^(main|master|trunk)$/.test(n) && n !== trunk) || null;

  // --- release branches ---------------------------------------------------
  // A branch named for a patch release (release/1.9.7) is git-flow scaffolding
  // that should merge back; one named for a major or minor (release-3.5,
  // release/2.1.x, v4) is a maintenance line that lives on beside the trunk.
  const releaseBranches = branches
    .map((b) => {
      const m = RELEASE_BRANCH.exec(b.name);
      const l = m ? null : LINE_BRANCH.exec(b.name);
      if (!m && !l) return null;
      const raw = (m ? m[2] : l[1]).replace(/^v\.?/i, 'v');
      const line = /\.x$/i.test(raw) || /^v?\d+(?:\.\d+)?$/.test(raw);
      const version = parseVersion(raw.replace(/\.x$/i, '')) || parseVersion(raw.replace(/\.x$/i, '') + '.0');
      return { ...b, kind: m ? m[1].toLowerCase() : 'line', line, version, label: line ? raw.replace(/^v/i, '') : null };
    })
    .filter(Boolean);

  // --- tags ---------------------------------------------------------------
  let releases = allTags
    .map((t) => ({ ...t, version: parseVersion(t.name) }))
    .filter((t) => t.version);
  if (!opts.prerelease) releases = releases.filter((r) => !r.version.pre);
  if (opts.tagPattern) {
    const re = new RegExp(opts.tagPattern);
    releases = releases.filter((r) => re.test(r.name));
  }
  // Several tags on one commit are one release: prometheus tags every release
  // twice (v3.15.1 and the Go-module mirror v0.315.1), and an rc often shares
  // its commit with the final. Keep the final, then the highest version.
  {
    const bySha = new Map();
    for (const r of releases) {
      const prev = bySha.get(r.sha);
      if (!prev) { bySha.set(r.sha, r); continue; }
      const better = (!r.version.pre && prev.version.pre) ||
        (!!r.version.pre === !!prev.version.pre && compareVersion(r.version, prev.version) > 0);
      const [keep, drop] = better ? [r, prev] : [prev, r];
      keep.aliases = [...(keep.aliases || []), drop.name, ...(drop.aliases || [])];
      bySha.set(r.sha, keep);
    }
    releases = [...bySha.values()];
  }
  releases.sort((a, b) => a.date - b.date || compareVersion(a.version, b.version));
  if (opts.limit && releases.length > opts.limit) {
    notes.push(`showing the newest ${opts.limit} of ${releases.length} releases (--limit)`);
    releases = releases.slice(-opts.limit);
  }
  if (!releases.length) throw new Error('No semver tags found. Check --tag-pattern / --prerelease.');

  // --- one pass over the commit graph -------------------------------------
  const refs = [
    ...integration.map((n) => byName.get(n).ref),
    ...releaseBranches.map((b) => b.ref),
    ...releases.map((r) => r.sha),
  ];
  const graph = await G.commitGraph(cwd, refs, { since: opts.since });
  if (!graph.size) throw new Error('Empty commit graph — is this a shallow clone? Try --since or a full fetch.');

  // Lightweight tags report the commit date; annotated tags report when the tag
  // was made. Take whichever is later so a release never predates its content.
  for (const rel of releases) {
    const c = graph.get(rel.sha);
    if (c && c.date > rel.date) rel.date = c.date;
  }
  releases.sort((a, b) => a.date - b.date || compareVersion(a.version, b.version));

  // --- ownership: the earliest release that contains a commit owns it ------
  const owner = new Map(); // sha -> release index
  releases.forEach((rel, idx) => {
    rel.index = idx;
    rel.commits = 0;
    rel.prs = [];
    rel.parentIndex = -1;
    rel.startDate = rel.date;
    if (!graph.has(rel.sha)) {
      rel.missing = true;
      return;
    }
    const stack = [rel.sha];
    let boundary = -1;
    let earliest = Infinity;
    const localPRs = new Map();
    while (stack.length) {
      const sha = stack.pop();
      const held = owner.get(sha);
      if (held !== undefined) {
        // walking into an older release marks where this one branched off;
        // re-reaching our own commits (a merge rejoining) says nothing
        if (held !== idx) boundary = Math.max(boundary, held);
        continue;
      }
      const c = graph.get(sha);
      if (!c) continue;
      owner.set(sha, idx);
      rel.commits++;
      if (c.date && c.date < earliest) earliest = c.date;
      const pr = parsePR(c);
      if (pr && !localPRs.has(pr.number)) {
        localPRs.set(pr.number, {
          number: pr.number,
          title: pr.title.slice(0, 160),
          author: c.author,
          date: c.date,
          sha: c.sha,
          style: pr.style,
        });
      }
      for (const p of c.parents) stack.push(p); // owned parents are filtered on pop, so boundaries are seen
    }
    rel.parentIndex = boundary;
    rel.prs = [...localPRs.values()].sort((a, b) => a.date - b.date);
    rel.firstCommitDate = earliest === Infinity ? rel.date : earliest;
  });

  // --- reachability: every release and branch marked in one pass -----------
  const RN = releases.length;
  const marks = [
    ...releases.map((r) => ({ sha: r.sha })),
    ...integration.map((n) => ({ sha: byName.get(n).sha })),
    ...releaseBranches.map((b) => ({ sha: b.sha })),
  ];
  const bs = buildBitsets(graph, marks);
  const branchBit = (name) => RN + integration.indexOf(name);
  const lineBits = releaseBranches
    .map((b, i) => (b.line ? RN + integration.length + i : -1))
    .filter((b) => b >= 0);

  // --- parent: the release this one was cut from ---------------------------
  //
  // Ownership alone cannot say: a fix merged into release/1.9.16 after its tag
  // and forward-ported into 2.0.1 is "owned" by 2.0.1, which shipped it first,
  // so v1.9.17 walks into 2.0.1's commits. Nor can tag ancestry: opencrvs
  // tags commits that never reach the next patch (v2.1.0's is not in v2.1.1).
  // So a release counts as in another's history when most of its own commits
  // are. Prefer the closest lower version on the same minor line (1.9.17 ->
  // 1.9.16), else the latest such release (a new minor off the trunk), else
  // keep the ownership boundary.
  {
    const held = new Uint32Array(RN * RN); // held[o * RN + i]: o's own commits inside i
    for (const [sha, o] of owner) {
      const w = bs.wordsOf(sha);
      if (!w) continue;
      for (let i = 0; i < RN; i++) if (bitOf(w, i)) held[o * RN + i]++;
    }
    const inside = (o, i) => (o.commits ? held[o.index * RN + i] * 2 >= o.commits : bs.has(o.sha, i));
    releases.forEach((rel, i) => {
      let same = null, latest = null;
      for (const o of releases) {
        if (o === rel || o.date > rel.date || !inside(o, i)) continue;
        if (o.version.major === rel.version.major && o.version.minor === rel.version.minor &&
          compareVersion(o.version, rel.version) < 0 && (!same || compareVersion(o.version, same.version) > 0)) same = o;
        if (!latest || o.date > latest.date) latest = o;
      }
      const pick = same || latest;
      if (pick) rel.parentIndex = pick.index;
    });
  }

  // Branch point: where this release's line left its predecessor.
  const spans = releases.map((r) => r.date - (r.parentIndex >= 0 ? releases[r.parentIndex].date : r.date)).filter((d) => d > 0).sort((a, b) => a - b);
  const typical = spans.length ? spans[Math.floor(spans.length / 2)] : 30 * 86400;
  for (const rel of releases) {
    const parent = rel.parentIndex >= 0 ? releases[rel.parentIndex] : null;
    rel.startDate = parent
      ? Math.max(parent.date, Math.min(rel.firstCommitDate, rel.date))
      // The very first release owns all of pre-history; drawing it to the repo's
      // first commit stretches the time axis over years of nothing.
      : Math.max(rel.firstCommitDate, rel.date - typical * 2);
    if (rel.startDate > rel.date) rel.startDate = rel.date;
  }


  // Where each PR NUMBER and each PR TITLE shows up, so a squash, cherry-pick
  // or backport still counts as the same change having arrived. `backports` records
  // which PRs each PR names ("Automated cherry pick of #9297"), title or branch.
  const prBits = new Map();
  const titleBits = new Map();
  const backports = new Map();
  {
    const or = (map, key, words) => {
      let acc = map.get(key);
      if (!acc) { acc = new Uint32Array(bs.W); map.set(key, acc); }
      for (let w = 0; w < bs.W; w++) acc[w] |= words[w];
    };
    const seen = new Set();
    for (const sha of bs.order) {
      const c = graph.get(sha);
      const pr = parsePR(c);
      if (pr) {
        for (const m of `${pr.title} ${pr.head || ''}`.matchAll(/(?:#|\bPR |\/pull\/)(\d+)/gi)) {
          if (+m[1] === pr.number) continue;
          if (!backports.has(pr.number)) backports.set(pr.number, new Set());
          backports.get(pr.number).add(+m[1]);
        }
      }
      const words = bs.wordsOf(sha);
      if (!words) continue;
      seen.clear();
      prMentions(c, seen);
      for (const num of seen) or(prBits, num, words);
      for (const t of new Set([normTitle(c.subject), pr ? normTitle(pr.title) : ''])) {
        if (matchableTitle(t)) or(titleBits, t, words);
      }
    }
  }

  /** The PR plus every PR it backports, following chains of backports. */
  const sources = (number) => {
    const out = [number];
    for (let i = 0; i < out.length && out.length < 16; i++) {
      for (const n of backports.get(out[i]) || []) if (!out.includes(n)) out.push(n);
    }
    return out;
  };

  /**
   * present = the commit itself is in there; equivalent = only its PR number
   * is, or that of a PR it backports, or its title. A backport ("[release-3.5]
   * backport #13145") is a new PR whose own number never reaches the trunk.
   */
  const presence = (sha, numbers, title, bit) => {
    if (bs.has(sha, bit)) return 'merged';
    for (const n of numbers) {
      const w = prBits.get(n);
      if (w && bitOf(w, bit)) return 'equivalent';
    }
    const w = title ? titleBits.get(title) : null;
    if (w && bitOf(w, bit)) return 'equivalent';
    return 'absent';
  };

  // --- lineage: which releases descend from which --------------------------
  releases.forEach((rel, i) => {
    const desc = marksOn(bs, rel.sha, i).filter((b) => b < RN);
    // An heir is a descendant nothing else descends from — the tip of a line.
    rel.heirIdx = desc.filter((d) => !desc.some((o) => o !== d && bs.has(releases[d].sha, o)));
    rel.descCount = desc.length;
    rel.heirs = rel.heirIdx.map((d) => releases[d].name);
  });

  // --- did each pull request survive? -------------------------------------
  //
  // Measured per PULL REQUEST against the tips, never against a release tag:
  // a tag routinely points at a release-prep commit that was never merged
  // anywhere (v1.9.7 here), while the work it names shipped long before. Tag
  // reachability is kept below purely to draw ancestry.
  //
  // The frontier is the highest version, not the latest by date: with
  // maintenance lines a patch to an old line (vitest v4.1.12) routinely ships
  // minutes after the current one (v5.0.5).
  const newest = releases.reduce((a, b) => (compareVersion(b.version, a.version) > 0 ? b : a));
  const forward = [
    ...integration.map((n) => ({ label: n, bit: branchBit(n), trunk: n === trunk })),
  ];

  const targetsOf = (rel) => [
    ...forward,
    ...(rel !== newest ? [{ label: newest.name, bit: newest.index }] : []),
  ];
  const verdictOf = (pr) => {
    const inTrunk = pr.status[trunk] !== 'absent';
    const anywhere = Object.values(pr.status).some((v) => v !== 'absent');
    return inTrunk ? 'carried' : anywhere ? 'drift' : 'lost';
  };

  for (const rel of releases) {
    for (const pr of rel.prs) {
      const numbers = sources(pr.number);
      const title = normTitle(pr.title);
      pr.status = {};
      for (const t of targetsOf(rel)) pr.status[t.label] = presence(pr.sha, numbers, title, t.bit);
      pr.verdict = verdictOf(pr);
    }
  }

  // What is still missing gets one more, costlier look: did the change itself
  // arrive, under a commit nothing above could tie to it?
  if (opts.patchId !== false) {
    if (await G.isPartialClone(cwd, remote)) {
      notes.push('patch-id matching skipped: partial clone (fetch the blobs, or pass --no-patch-id)');
    } else {
      const open = releases.flatMap((rel) => rel.prs.filter((pr) => pr.verdict !== 'carried'));
      const bits = [...forward.map((f) => f.bit), newest.index];
      const found = await patchEquivalents(cwd, graph, bs, open, bits,
        [...integration.map((n) => byName.get(n).ref), newest.sha], opts.since);
      let resolved = 0;
      for (const rel of releases) {
        for (const pr of rel.prs) {
          const w = found.get(pr);
          if (!w) continue;
          const was = pr.verdict;
          for (const t of targetsOf(rel)) {
            if (pr.status[t.label] !== 'absent' || !bitOf(w, t.bit)) continue;
            pr.status[t.label] = 'equivalent';
            pr.byPatch = true;
          }
          pr.verdict = verdictOf(pr);
          if (pr.verdict !== was) resolved++;
        }
      }
      if (open.length) notes.push(`patch-id matching traced ${resolved} of ${open.length} pull requests nothing else could`);
    }
  }

  for (const rel of releases) {
    let carried = 0, drift = 0, lost = 0;
    for (const pr of rel.prs) {
      if (pr.verdict === 'carried') carried++;
      else if (pr.verdict === 'drift') drift++;
      else lost++;
    }
    rel.carried = carried;
    rel.driftPRs = drift;
    rel.lostPRs = lost;
    rel.missingPRs = drift + lost; // what the current renderer colours red
    rel.status = {};
    for (const name of integration) rel.status[name] = presence(rel.sha, [], null, branchBit(name));
    rel.onLine = lineBits.some((b) => bs.has(rel.sha, b));
    // A tag whose own commit went nowhere but whose work did: release-prep noise.
    // A tag that lives on a maintenance line went exactly where it should.
    rel.tagOnlyDangling = !rel.onLine && integration.every((n) => rel.status[n] === 'absent') && lost === 0 && rel.prs.length > 0;
  }

  // --- release branches still carrying unmerged work ----------------------
  const branchReport = releaseBranches.map((b) => {
    const tipIn = {};
    for (const name of integration) tipIn[name] = bs.has(b.sha, branchBit(name)) ? 'merged' : 'absent';
    let ahead = 0;
    if (graph.has(b.sha) && integration.some((n) => tipIn[n] === 'absent')) {
      for (const sha of reachable(graph, [b.sha])) {
        if (!integration.some((n) => bs.has(sha, branchBit(n)))) ahead++;
      }
    }
    return {
      name: b.name,
      kind: b.kind,
      line: b.line,
      sha: b.sha,
      date: b.date,
      version: b.version ? (b.label || versionLabel(b.version)) : null,
      status: tipIn,
      ahead,
    };
  }).sort((a, b) => b.date - a.date);

  const remoteRaw = await G.remoteUrl(cwd, remote);

  return {
    repo: {
      name: (cwd.split('/').pop() || cwd),
      root: cwd,
      remote: remoteRaw,
      web: G.webUrl(remoteRaw),
      github: G.githubSlug(remoteRaw),
      generatedAt: Date.now(),
    },
    integration,
    trunk,
    prod,
    releases: releases.map((r) => ({
      name: r.name,
      aliases: r.aliases || [],
      version: versionLabel(r.version),
      pre: !!r.version.pre,
      sha: r.sha,
      date: r.date,
      startDate: r.startDate,
      // where its line left the parent: the parent's tag, before any work began
      branchDate: r.parentIndex >= 0 ? Math.min(releases[r.parentIndex].date, r.startDate) : r.startDate,
      firstCommitDate: r.firstCommitDate,
      tagger: r.tagger,
      subject: r.subject.slice(0, 200),
      commits: r.commits,
      status: r.status,
      heirs: r.heirs,
      isTip: r.heirs.length === 0,
      carried: r.carried,
      driftPRs: r.driftPRs,
      lostPRs: r.lostPRs,
      tagOnlyDangling: r.tagOnlyDangling,
      onLine: r.onLine,
      missingPRs: r.missingPRs,
      parent: r.parentIndex >= 0 ? releases[r.parentIndex].name : null,
      prs: r.prs,
    })),
    branches: branchReport,
    summary: {
      releases: releases.length,
      prs: releases.reduce((n, r) => n + r.prs.length, 0),
      carried: releases.reduce((n, r) => n + r.carried, 0),
      drift: releases.reduce((n, r) => n + r.driftPRs, 0),
      lost: releases.reduce((n, r) => n + r.lostPRs, 0),
      newest: newest.name,
      danglingTags: releases.filter((r) => r.tagOnlyDangling).map((r) => r.name),
    },
    notes,
  };
}
