# release-graph — progress / handoff

**Status: working end to end.** Verified against `~/projects/opencrvs/opencrvs-core`
(82 tags, 25k commits, git-flow, `release-v*` branches) — 51 releases, 5415 PRs,
0.7s, 1.28 MB output.

Last session: 2026-10-30 (published 0.2.1 to npm).

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

## 2026-10-29 — single default branch + minor-line maintenance repos

opencrvs-core has since dropped `master` (only `develop`, plus `release/X.Y.Z`
and `release/X.Y.x` lines). Still works: integration = `[develop]`, prod = null,
the UI draws no prod rail. Also tested against blobless clones of prometheus
(`release-3.x`), etcd (`release-3.x`, no merge-back) and vitest (`v4`, `v3.1`).

| repo | before | after |
| --- | --- | --- |
| prometheus | 348 releases (100 dupes), newest `v0.315.1` | 248, newest `v3.15.1`, 52 lost |
| etcd | 1089 lost, 8 dangling tags | 528 lost, 0 dangling |
| vitest | frontier `v4.1.12`, 30 drift, v4.1.x "dangling" | frontier `v5.0.5`, 22 lost |
| opencrvs-core | 91 lost | 57 lost |

Fixes, all in `src/model.js` unless noted:

1. **Tags sharing a commit are one release** (`aliases`). Prometheus tags every
   release twice: `v3.15.1` and the Go-module mirror `v0.315.1`.
2. **Frontier = highest version, not latest date.** vitest shipped v4.1.12
   13 minutes after v5.0.5. `summary.newest` keeps its name.
3. **Bare version branches are release lines**: `v4`, `v3.1`, `1.9.x`,
   `stable/5.0.x` (`LINE_BRANCH`). Branches named for a major/minor (`line: true`)
   are maintenance lines; `release/1.9.x` no longer parses as `1.9.0-x`.
4. **Tags on a maintenance line aren't dangling** (`onLine`), draw no red
   merge-back stub (`app.js`), and lines are left out of the red strip (`render.js`).
5. **Backports**: a backport PR has its own number, which never reaches the trunk.
   Now equivalent if (a) a PR it names, followed transitively through the title
   or source branch (`#N`, `PR N`, `/pull/N`), is present: etcd #9401 → #9297 →
   #9281; or (b) its `normTitle()` matches a commit or PR title on the target.
   Sampled verdicts were checked against `git log --grep` on the trunk; all real.

**Patch-id matching** (`src/patchid.js`, same day) runs last, on PRs that are
still lost or drift. Each one's whole diff (merge vs first parent) and each
inner commit (`rev-list M^2 ^M^1`) gets a patch-id. A PR counts as equivalent
at a target where its whole diff matches, or where *every* inner commit does.
Only target commits touching exactly the same path set are hashed: one
`--name-only` pass of about 1s. Hashing the whole trunk took 7s (etcd) and
25s (opencrvs); an author filter barely narrowed it (49s on opencrvs, since
merge diffs are huge).

| repo | traced by patch-id | lost after | time |
| --- | --- | --- | --- |
| opencrvs-core | 16 of 61 | 41 | 1.0s → 6.0s |
| etcd | 29 of 552 | 501 | 0.7s → 5.6s |
| prometheus | 4 of 52 | 48 | 0.8s → 3.9s |
| vitest | 1 of 22 | 21 | 1.0s → 1.4s |

Samples were verified independently (path-limited `git log -p | git patch-id`
on the trunk), and every one had a real counterpart. Skipped with a note on
partial clones (`remote.<r>.promisor`), where each diff would fetch blobs
lazily. The etcd leftovers are genuinely different changes: per-line Go and
dependency bumps (`go.sum` differs), bundled backports, and typo fixes in code
`main` has since rewritten. That is the limit of what git history can trace.
`pr.byPatch` marks matches made this way (JSON only, not shown in the UI).

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
10. Row sub-labels ("date · N PRs · 3 not in v2.1.2 · 1 off develop") overflowed
    the 216px gutter and were cut with an ellipsis, worst on Windows with Google
    Fonts blocked (the mono stack had no Windows font, so it fell to Courier New).
    Counts are now `3 lost` / `1 drift` badges beside the name, numbers only
    under 720px; Consolas / Cascadia Mono / Liberation Mono are in the stack.
11. Under 1100px the 400px panel left the chart a ~200px sliver; it now floats
    over the chart, and the track gains its width as scroll room so `reveal()`
    can pull the newest release out from under it. `reveal()` checks the tag end,
    not the whole ribbon: a long ribbon could be "visible" with its tag hidden.
12. The newest tag's label and merge arm were clipped at the right edge
    (44px pad); the right pad is now `PAD_R` = 110.
13. A drift PR's panel line read "not on main — on" with nothing after it: it
    only listed integration branches, not the newest release where it was.
14. Maintenance-line tags showed a red `main · absent` pill in the panel,
    contradicting the ribbon; now a neutral "stays on its maintenance line".
15. The theme toggle had a dead third state (system = light); the prereleases
    toggle showed when the model held no prereleases.
16. v1.9.17 showed as cut from v2.0.1. A fix merged into release/1.9.16 after
    its tag and forward-ported into 2.0.1 is owned by 2.0.1 (it shipped first),
    and the parent was "the newest owner walked into". The parent is now a
    release whose own commits are mostly (>= half) in this release's history,
    preferring the closest lower version on the same minor line. Tag ancestry
    alone fails here: opencrvs tags commits that never reach the next patch
    (v2.1.0's tag is not in v2.1.1). The ribbon now leaves the trunk at the
    parent's tag (`branchDate`) and idles dashed until the first commit.

To test responsiveness, frame the report at fixed widths in a same-origin iframe
(the browser window can't always be resized). For the office-PC case, remove the
Google Fonts `<link>` and strip the Mac fonts from `--mono`.

## Next steps

Publish-blocking:

- [x] `repository` field is in package.json.
- [x] Published: 0.1.0 on 2026-09-06, 0.2.0 and 0.2.1 on 2026-10-30 (maintenance lines,
      patch-id, responsive UI). Publishing needs an authenticator OTP (`--otp`).

Known gaps, none blocking:

- [x] `--github` executed 2026-09-06 against opencrvs-core (50 of 66 releases matched)
      and chalk (31 of 33), plus both failure branches: non-GitHub remote, and a
      404 slug. Works unauthenticated on public repos.
      Still unexercised: the **authenticated** branch (Authorization header never
      sent), the 401/403 error branch, and **pagination past page 1** — both test
      repos have fewer than 100 releases, so the `page` loop has only ever run once.
- [ ] Tested shapes: git-flow with and without master (opencrvs-core), trunk-only
      (chalk), minor/major maintenance lines (prometheus, etcd, vitest). Untested:
      Bitbucket subjects, rebase-merge repos, monorepos with scoped tags
      (`pkg@1.2.3` — `parseVersion` rejects those), non-prefixed lines like `19.0.x`
      on a huge repo (angular).
- [x] Patch-id equivalence added 2026-10-29 (see above). Possible next step:
      surface `byPatch` in the PR detail panel.
- [ ] Tests cover the pure functions, the bitset and patch-id matching (one
      fixture repo, 8 tests). No fixture exercising ownership/verdicts end to end — worth adding given the verdict
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
