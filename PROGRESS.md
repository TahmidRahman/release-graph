# release-graph — progress / handoff

**Status: working end to end.** Verified against `~/projects/opencrvs/opencrvs-core`
(82 tags, 25k commits, git-flow, `release-v*` branches) — 51 releases, 5415 PRs,
0.7s, 1.28 MB output.

Last session: 2026-09-05 (publish prep).

---

## Decisions already locked (from Q&A — do not relitigate)

| Question | Answer |
| --- | --- |
| What is a "release" | semver **git tags** + **`release/*` branches** + optional **GitHub Releases API** |
| Where PRs come from | **merge-commit / squash-subject parsing, fully offline** |
| Output | **single self-contained HTML file** (no server, no runtime deps) |
| Renderer | **custom SVG lane layout** (my call — inlining D3 into a self-contained file isn't worth it, and the hover-split needs full geometry control) |
| Target repo | **cwd only** (`--no-fetch` to skip the fetch) |
| Scale | **200+ releases** → virtualized rows, `--limit`, `--since` |
| Integration branches | **auto-detect git-flow** |

## 2026-09-05 — the metric was measuring the wrong thing

Product goal, from the user: **release rhythm** + **did every feature carry on
into the following releases**. The original metric answered neither.

It reported "102 unlanded PRs" by asking *is this commit reachable from the tips
of develop/master*. That conflates three unrelated things. The rewrite
(`src/lineage.js` + the analysis half of `src/model.js`) classifies each PR:

| verdict | meaning | opencrvs-core |
| --- | --- | --- |
| `carried` | present on the trunk | 5,313 (98.1%) |
| `drift` | shipped, but the trunk has never seen it | 23 |
| `lost` | in no integration branch **and** absent from the newest release | 79 |

Three traps found while getting there, all verified against raw git:

1. **A release tag is not its content.** v1.9.7's tag points at an unmerged
   release-prep commit while every PR it names shipped long before. Measuring
   tag reachability flagged it (and v0.2.6, v1.7.3) as a disaster. Reported as
   `tagOnlyDangling` now and excluded from the alarms.
2. **Heir-based carry-forward is vacuous at the tips.** Checking "did this
   survive into its descendants" returns a clean 0 for a release that has no
   descendants — which is exactly the dead-end case you care about.
3. **Lineage is not date order.** Pairing releases chronologically gave
   `v2.0.0 -> v1.9.16: 200 of 200 dropped`; v1.9.16 is on the maintenance line,
   not descended from v2.0.0.

`buildBitsets()` marks each release tag and integration branch with a bit and
floods them backwards through parent edges in one pass, so "which releases
contain this commit" is a bit test. **Requires `git log --topo-order`** —
without it the flood visits a parent before one of its children.

UI: light/blue OpenCRVS theme is now the default in `src/client/styles.css`
(dark is opt-in via the toggle, no longer system-driven); Poppins + IBM Plex
Mono load from Google Fonts with a full system fallback stack.

## What works

- One `git log` pass builds the whole commit graph; all set math is done in JS.
- Commit ownership: earliest release (chronologically) that contains a commit.
- Branch-point detection via DFS boundary — correctly shows parallel lines
  (`v1.2.1` and `v1.3.0` both fork from `v1.2.0`).
- Reachability per integration branch + PR-number fallback for squash/cherry-pick.
- Release branches still carrying unmerged commits → red strip at the top.
- UI: virtualized rows, hover-to-split-into-PRs overlay, detail panel (unlanded
  PRs first), search, "problems only" filter, zoom, light/dark theme,
  diagonal soft-follow scrolling, click-to-reveal.

**Correctness was cross-checked against git directly** — a sample of `absent` and
`merged` PR verdicts matched `git merge-base --is-ancestor` and `git log --grep`
exactly. Worth re-running that check after any change to `model.js`.

## Bugs already found and fixed (don't reintroduce)

1. `for-each-ref` can't take a literal NUL in argv → use `%00`/`%1f` in the format.
2. git terminates each `for-each-ref` record with `\0\n`, so every record after
   the first has a **leading newline** — must be stripped, or branch names like
   `\nmaster` silently break integration detection.
3. Ordering releases by semver was wrong: a stray lightweight tag (`v0.2.6` on a
   2025 commit) sorted first and claimed 18k commits. **Order by commit date.**
4. Branch-point DFS filtered already-owned parents at push time, so boundaries
   were never seen. Filter on pop instead.
5. The root release stretched the time axis back to the repo's first commit
   (2017) — clamp its drawn start to ~2× the typical release span.
6. `invalidate()` computed the visible row window from a stale `scrollTop` after
   filtering, so rows rendered empty. Clamp `scrollTop` first.
7. `follow()` fought click-to-reveal; follow now tracks the selected release.
8. `requestAnimationFrame` doesn't fire in a background tab — `reveal()` is
   synchronous now (reading `clientWidth` forces the reflow we needed).
9. `backdrop-filter` on a full-width overlay froze the compositor; the overlay
   is now scoped to the release's own span with a solid background.

## Next steps

Publish-blocking:

- [ ] **Add a `repository` field to package.json** before `npm publish` — npm
      shows no source link without it. I did not guess the URL:
      `"repository": { "type": "git", "url": "git+https://github.com/<you>/release-graph.git" }`
- [ ] `npm publish` — the name `release-graph` was free on the registry as of
      2026-09-05. `npm pack --dry-run` is clean: 26.2 kB, src + README + LICENSE only.

Known gaps, none blocking:

- [x] `--github` executed 2026-09-06 against opencrvs-core (50 of 66 releases matched)
      and chalk (31 of 33), plus both failure branches: non-GitHub remote, and a
      404 slug. Works unauthenticated on public repos.
      Still unexercised: the **authenticated** branch (Authorization header never
      sent), the 401/403 error branch, and **pagination past page 1** — both test
      repos have fewer than 100 releases, so the `page` loop has only ever run once.
- [ ] Only two repo shapes tested: opencrvs-core (git-flow, develop+master+`release-*`)
      and chalk (trunk-based, `main` only). Untested: Bitbucket subjects, rebase-merge
      repos, monorepos with scoped tags (`pkg@1.2.3` — `parseVersion` rejects those).
- [ ] Equivalence matches by PR **number**, not patch-id. `git cherry` /
      `git log --cherry-mark` do this better; switching would catch rebased and
      cherry-picked commits this misses. Best single accuracy improvement available.
- [ ] Tests cover the pure functions and the bitset only (6 tests). No fixture repo
      exercising ownership/verdicts end to end — worth adding given the verdict
      semantics changed three times.

## How to run it

```bash
cd ~/projects/opencrvs/opencrvs-core
node ~/projects/release-graph/src/cli.js --no-fetch --json /tmp/rg.json
```

`file://` URLs are blocked by the browser tooling, so to inspect the output:

```bash
cd <dir with the html> && python3 -m http.server 8731
```
