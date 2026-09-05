import { spawn } from 'node:child_process';

const FS = '\x1f'; // field separator
const RS = '\x00'; // record separator (git -z)
// for-each-ref cannot take literal NUL in argv, so ask git to emit the bytes itself
const FS_REF = '%1f';
const RS_REF = '%00';

/** Run git and buffer stdout. Streams so we are not bound by execSync's maxBuffer. */
export function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      if (code !== 0 && !allowFail) {
        reject(new Error(`git ${args.slice(0, 3).join(' ')} failed (${code}): ${Buffer.concat(err).toString('utf8').trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Split `git -z --format=...%x1f...` output into arrays of fields. */
function records(stdout) {
  const rows = [];
  for (const raw of stdout.split(RS)) {
    // git terminates each for-each-ref record with "\0\n", so every record
    // after the first arrives with a leading newline
    const rec = raw.charCodeAt(0) === 10 ? raw.slice(1) : raw;
    if (!rec) continue;
    rows.push(rec.split(FS));
  }
  return rows;
}

export async function isRepo(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

export async function repoRoot(cwd) {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

export async function remoteUrl(cwd, remote) {
  const url = (await git(cwd, ['remote', 'get-url', remote], { allowFail: true })).trim();
  return url || null;
}

/** Best-effort normalisation of a git remote into an https browse URL. */
export function webUrl(remote) {
  if (!remote) return null;
  let u = remote.trim().replace(/\.git$/, '');
  // scp-like: git@host:owner/repo  (host may be an ssh alias such as github-work)
  const scp = u.match(/^(?:[\w.-]+@)?([\w.-]+):(.+)$/);
  if (scp && !u.includes('://')) {
    let host = scp[1];
    if (/github/i.test(host)) host = 'github.com';
    else if (/gitlab/i.test(host)) host = 'gitlab.com';
    else if (/bitbucket/i.test(host)) host = 'bitbucket.org';
    u = `https://${host}/${scp[2]}`;
  } else {
    u = u.replace(/^ssh:\/\/(?:[\w.-]+@)?/, 'https://').replace(/^git:\/\//, 'https://');
  }
  return u.startsWith('http') ? u : null;
}

/** owner/repo for a GitHub remote, else null. */
export function githubSlug(remote) {
  const w = webUrl(remote);
  if (!w) return null;
  const m = w.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function fetchAll(cwd, remote) {
  await git(cwd, ['fetch', '--tags', '--prune', '--quiet', remote], { allowFail: true });
}

/** All tags with their peeled commit, date and message. */
export async function listTags(cwd) {
  const fmt = ['%(refname:short)', '%(objectname)', '%(*objectname)', '%(creatordate:unix)', '%(taggername)', '%(subject)'].join(FS_REF);
  const out = await git(cwd, ['for-each-ref', '--format=' + fmt + RS_REF, 'refs/tags']);
  return records(out).map(([name, obj, peeled, date, tagger, subject]) => ({
    name,
    sha: peeled || obj,
    date: Number(date) || 0,
    tagger: tagger || '',
    subject: subject || '',
  }));
}

/** Remote-tracking branches for `remote`, plus local branches when there is no remote. */
export async function listBranches(cwd, remote) {
  const fmt = ['%(refname:short)', '%(objectname)', '%(committerdate:unix)'].join(FS_REF);
  const scopes = [`refs/remotes/${remote}`, 'refs/heads'];
  const out = await git(cwd, ['for-each-ref', '--format=' + fmt + RS_REF, ...scopes]);
  const seen = new Map();
  for (const [refname, sha, date] of records(out)) {
    if (!refname || refname.endsWith('/HEAD')) continue;
    const short = refname.startsWith(remote + '/') ? refname.slice(remote.length + 1) : refname;
    // remote-tracking wins over the local branch of the same name
    const isRemote = refname.startsWith(remote + '/');
    const prev = seen.get(short);
    if (prev && prev.isRemote && !isRemote) continue;
    seen.set(short, { name: short, ref: refname, sha, date: Number(date) || 0, isRemote });
  }
  return [...seen.values()];
}

/** The remote's HEAD branch (`develop` for opencrvs-core), falling back to local HEAD. */
export async function defaultBranch(cwd, remote) {
  const head = (await git(cwd, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], { allowFail: true })).trim();
  if (head) return head.replace(`refs/remotes/${remote}/`, '');
  const local = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true })).trim();
  return local || null;
}

/**
 * One pass over the commit graph for the given refs.
 * Returns a Map sha -> {sha, parents, date, author, subject}.
 */
export async function commitGraph(cwd, refs, { since } = {}) {
  const fmt = ['%H', '%P', '%ct', '%an', '%s', '%b'].join(FS);
  // --topo-order is required: buildBitsets() floods reachability bits from
  // children to parents in a single pass and needs children emitted first.
  const args = ['log', '-z', '--topo-order', '--format=' + fmt, '--no-show-signature'];
  if (since) args.push(`--since=${since}`);
  args.push(...refs, '--');
  const out = await git(cwd, args);
  const map = new Map();
  for (const rec of out.split(RS)) {
    if (!rec) continue;
    const i1 = rec.indexOf(FS);
    const i2 = rec.indexOf(FS, i1 + 1);
    const i3 = rec.indexOf(FS, i2 + 1);
    const i4 = rec.indexOf(FS, i3 + 1);
    const i5 = rec.indexOf(FS, i4 + 1);
    if (i5 < 0) continue;
    const sha = rec.slice(0, i1).replace(/^\n/, '');
    const parents = rec.slice(i1 + 1, i2);
    map.set(sha, {
      sha,
      parents: parents ? parents.split(' ') : [],
      date: Number(rec.slice(i2 + 1, i3)) || 0,
      author: rec.slice(i3 + 1, i4),
      subject: rec.slice(i4 + 1, i5),
      body: rec.slice(i5 + 1, i5 + 400).split('\n')[0],
    });
  }
  return map;
}
