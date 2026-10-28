#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as G from './git.js';
import { build } from './model.js';
import { enrich } from './github.js';
import { renderHTML } from './render.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8'));

const HELP = `
  release-graph v${pkg.version}
  Visualize how releases branch off and merge back into develop/master.

  Usage
    $ npx release-graph [options]              run inside a git repository

  Options
    -o, --out <file>       output file            (default release-graph.html)
        --json <file>      also write the raw model as JSON
        --remote <name>    remote to read         (default origin)
        --branches <list>  integration branches   (default: auto-detect git-flow)
        --tag-pattern <re> only tags matching this regex
        --prerelease       include prerelease tags (1.8.0-rc.1)
        --limit <n>        only the newest N releases
        --since <date>     ignore history older than this (e.g. "2 years ago")
        --github           enrich from the GitHub Releases API (GITHUB_TOKEN or gh)
        --no-patch-id      skip patch-id matching of backports (faster)
        --no-fetch         skip "git fetch --tags"
        --no-open          do not open the result in a browser
    -h, --help             show this
    -v, --version          show version

  Reading the output
    Each release is a coloured ribbon that leaves the trunk and rejoins it.
    A dashed red end means the release never merged back (tags on maintenance
    lines such as release-3.5 or v4 are expected not to) — hover the ribbon
    to expand it into the pull requests it shipped, colour-coded by whether
    each one is actually present on every integration branch.
`;

function parseArgs(argv) {
  const o = {
    out: 'release-graph.html',
    json: null,
    remote: 'origin',
    integration: null,
    tagPattern: null,
    prerelease: false,
    limit: 0,
    since: null,
    github: false,
    patchId: true,
    fetch: true,
    open: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '-o': case '--out': o.out = next(); break;
      case '--json': o.json = next(); break;
      case '--remote': o.remote = next(); break;
      case '--branches': o.integration = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--tag-pattern': o.tagPattern = next(); break;
      case '--prerelease': o.prerelease = true; break;
      case '--limit': o.limit = Number(next()) || 0; break;
      case '--since': o.since = next(); break;
      case '--github': o.github = true; break;
      case '--no-patch-id': o.patchId = false; break;
      case '--no-fetch': o.fetch = false; break;
      case '--no-open': o.open = false; break;
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

const t0 = Date.now();
const step = (msg) => process.stderr.write(`  ${msg}\n`);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return void process.stdout.write(HELP);
  if (opts.version) return void process.stdout.write(pkg.version + '\n');

  const cwd = process.cwd();
  if (!(await G.isRepo(cwd))) {
    throw new Error('not a git repository — run release-graph inside a clone');
  }
  const root = await G.repoRoot(cwd);

  if (opts.fetch) {
    step(`fetching tags from ${opts.remote}…`);
    await G.fetchAll(root, opts.remote);
  }

  step('reading the commit graph…');
  const model = await build(root, opts);

  if (opts.github) {
    step('fetching GitHub releases…');
    const r = await enrich(model, { slug: model.repo.github });
    if (r.ok) model.notes.push(`matched ${r.matched} of ${r.total} published GitHub releases`);
    else model.notes.push(`GitHub enrichment skipped: ${r.reason}`);
  }

  const html = renderHTML(model, pkg.version);
  const outPath = resolve(cwd, opts.out);
  writeFileSync(outPath, html);
  if (opts.json) writeFileSync(resolve(cwd, opts.json), JSON.stringify(model, null, 2));

  const s = model.summary;
  const pct = s.prs ? ((s.carried / s.prs) * 100).toFixed(1) : '0';
  process.stderr.write(
    `\n  ${s.releases} releases · ${s.prs} pull requests\n` +
    `  ${s.carried} carried forward (${pct}%)` +
    (s.drift ? `  ·  ${s.drift} shipped but not on ${model.trunk}` : '') +
    (s.lost ? `  ·  ${s.lost} not in ${s.newest}` : '') + `\n` +
    (s.lost ? `  the ${s.lost} are candidates for review, not proven regressions — they may have been\n  superseded or deliberately reverted. Check before cherry-picking.\n` : '') +
    (s.danglingTags.length ? `  ${s.danglingTags.length} ${s.danglingTags.length === 1 ? 'tag points' : 'tags point'} at unmerged release-prep commits (${s.danglingTags.join(', ')}) — ignored\n` : '') +
    `  ${outPath}  (${(html.length / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s)\n\n`
  );
  for (const n of model.notes) process.stderr.write(`  note: ${n}\n`);

  if (opts.open) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(cmd, [outPath], { detached: true, stdio: 'ignore' }).unref();
  }
}

main().catch((e) => {
  process.stderr.write(`\n  release-graph: ${e.message}\n\n`);
  process.exit(1);
});
