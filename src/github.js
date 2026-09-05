import { execFileSync } from 'node:child_process';

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Enrich tag-derived releases with published GitHub Release metadata
 * (title, notes, draft/prerelease flags, author). Best-effort: any failure
 * leaves the offline model untouched.
 */
export async function enrich(model, { slug }) {
  if (!slug) return { ok: false, reason: 'remote is not github.com' };
  const auth = token();
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'release-graph' };
  if (auth) headers.Authorization = `Bearer ${auth}`;

  const byTag = new Map();
  try {
    for (let page = 1; page <= 10; page++) {
      const res = await fetch(`https://api.github.com/repos/${slug}/releases?per_page=100&page=${page}`, { headers });
      if (!res.ok) {
        return { ok: false, reason: `GitHub API ${res.status}${res.status === 401 || res.status === 403 ? ' (set GITHUB_TOKEN)' : ''}` };
      }
      const batch = await res.json();
      if (!Array.isArray(batch) || !batch.length) break;
      for (const r of batch) byTag.set(r.tag_name, r);
      if (batch.length < 100) break;
    }
  } catch (e) {
    return { ok: false, reason: e.message };
  }

  let matched = 0;
  for (const rel of model.releases) {
    const gh = byTag.get(rel.name);
    if (!gh) continue;
    matched++;
    rel.github = {
      title: gh.name || null,
      url: gh.html_url,
      draft: gh.draft,
      prerelease: gh.prerelease,
      author: gh.author?.login || null,
      publishedAt: gh.published_at ? Date.parse(gh.published_at) : null,
      body: (gh.body || '').slice(0, 4000),
    };
    if (gh.prerelease) rel.pre = true;
  }
  return { ok: true, matched, total: byTag.size };
}
