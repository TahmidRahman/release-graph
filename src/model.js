import * as G from './git.js';
import { buildBitsets, bitOf, marksOn } from './lineage.js';

const SEMVER = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-.]([0-9A-Za-z][0-9A-Za-z.-]*))?$/;
const RELEASE_BRANCH = /^(release|hotfix|support)[/-](.+)$/i;
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
  const releaseBranches = branches
    .filter((b) => RELEASE_BRANCH.test(b.name))
    .map((b) => {
      const m = RELEASE_BRANCH.exec(b.name);
      return { ...b, kind: m[1].toLowerCase(), version: parseVersion(m[2].replace(/^v\.?/i, 'v')) };
    });

  // --- tags ---------------------------------------------------------------
  let releases = allTags
    .map((t) => ({ ...t, version: parseVersion(t.name) }))
    .filter((t) => t.version);
  if (!opts.prerelease) releases = releases.filter((r) => !r.version.pre);
  if (opts.tagPattern) {
    const re = new RegExp(opts.tagPattern);
    releases = releases.filter((r) => re.test(r.name));
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

  // --- reachability: every release and branch marked in one pass -----------
  const RN = releases.length;
  const marks = [
    ...releases.map((r) => ({ sha: r.sha })),
    ...integration.map((n) => ({ sha: byName.get(n).sha })),
  ];
  const bs = buildBitsets(graph, marks);
  const branchBit = (name) => RN + integration.indexOf(name);

  // Where each PR NUMBER shows up, so a squash or cherry-pick still counts as
  // the same pull request having arrived.
  const prBits = new Map();
  {
    const seen = new Set();
    for (const sha of bs.order) {
      const words = bs.wordsOf(sha);
      if (!words) continue;
      seen.clear();
      prMentions(graph.get(sha), seen);
      for (const num of seen) {
        let acc = prBits.get(num);
        if (!acc) { acc = new Uint32Array(bs.W); prBits.set(num, acc); }
        for (let w = 0; w < bs.W; w++) acc[w] |= words[w];
      }
    }
  }

  /** present = the commit itself is in there; equivalent = only its PR number is. */
  const presence = (sha, prNumber, bit) => {
    if (bs.has(sha, bit)) return 'merged';
    const w = prNumber != null ? prBits.get(prNumber) : null;
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
  const newest = releases[releases.length - 1];
  const forward = [
    ...integration.map((n) => ({ label: n, bit: branchBit(n), trunk: n === trunk })),
  ];

  for (const rel of releases) {
    let carried = 0, drift = 0, lost = 0;
    const ahead = rel !== newest ? newest : null;
    for (const pr of rel.prs) {
      pr.status = {};
      for (const f of forward) pr.status[f.label] = presence(pr.sha, pr.number, f.bit);
      if (ahead) pr.status[ahead.name] = presence(pr.sha, pr.number, ahead.index);

      const inTrunk = pr.status[trunk] !== 'absent';
      const anywhere = Object.values(pr.status).some((v) => v !== 'absent');
      pr.verdict = inTrunk ? 'carried' : anywhere ? 'drift' : 'lost';
      if (pr.verdict === 'carried') carried++;
      else if (pr.verdict === 'drift') drift++;
      else lost++;
    }
    rel.carried = carried;
    rel.driftPRs = drift;
    rel.lostPRs = lost;
    rel.missingPRs = drift + lost; // what the current renderer colours red
    rel.status = {};
    for (const name of integration) rel.status[name] = presence(rel.sha, null, branchBit(name));
    // A tag whose own commit went nowhere but whose work did: release-prep noise.
    rel.tagOnlyDangling = integration.every((n) => rel.status[n] === 'absent') && lost === 0 && rel.prs.length > 0;
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
      sha: b.sha,
      date: b.date,
      version: b.version ? versionLabel(b.version) : null,
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
      version: versionLabel(r.version),
      pre: !!r.version.pre,
      sha: r.sha,
      date: r.date,
      startDate: r.startDate,
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
      newest: releases[releases.length - 1].name,
      danglingTags: releases.filter((r) => r.tagOnlyDangling).map((r) => r.name),
    },
    notes,
  };
}
