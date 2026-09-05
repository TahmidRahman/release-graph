# release-graph

Run it inside a git repository and it writes one self-contained HTML page
answering two questions:

- **How fast do we ship?** — release cadence over time, and how parallel
  maintenance lines overlap.
- **Did the work survive?** — for every pull request in every release, is it
  still present in the branches and releases that followed, or did it quietly
  stop somewhere?

```bash
cd your-repo
npx release-graph
```

No install, no config, no dependencies. It reads git and writes
`release-graph.html`.

---

## What it tells you

```
  51 releases · 5415 pull requests
  5313 carried forward (98.1%)  ·  23 shipped but not on develop  ·  79 not in v2.0.1
  the 79 are candidates for review, not proven regressions — they may have been
  superseded or deliberately reverted. Check before cherry-picking.
  3 tags point at unmerged release-prep commits (v0.2.6, v1.7.3, v1.9.7) — ignored
```

Every pull request gets one of three verdicts:

| verdict | meaning | what to do |
| --- | --- | --- |
| **carried forward** | present on your trunk (`develop`, or `main`) | nothing |
| **not on `<trunk>`** | it shipped on the production line, but the trunk has never seen it | forward-port it, or the next release off the trunk regresses it |
| **not in `<newest release>`** | in no integration branch *and* absent from your newest release | **review it** — see the caveat below |

The distinction between the last two matters. The middle one is a *forecast*
("this will break when you next release from the trunk"). The last one is a
*question* ("this went somewhere and never came back — was that on purpose?").
Most tools collapse both into one alarming number. This one doesn't.

## Reading the page

Two views of the same data.

**Rhythm** puts time on the x-axis — the only layout where cadence is visible.
Each release is a coloured ribbon that leaves the trunk and rejoins at its tag,
with a band above showing days elapsed since the previous release.

**Carry-forward** is one row per release, ancestry drawn as a connected spine,
with per-release verdict counts. Hover a release to split its line open into the
pull requests it shipped, colour-coded by verdict. Click one for the full list,
worst first, linked to GitHub.

| What you see | What it means |
| --- | --- |
| Solid arm back to the rail | reachable from that branch |
| Dashed **amber** arm + ⚠ | shipped, but the trunk has not seen it |
| Dashed **red** arm + ⚠ | not in the newest release either |
| Red strip at the top | release branches still holding commits on no integration branch |

Rows are chronological and the x-axis is time, so content runs on a diagonal;
the view follows it as you scroll. `/` focuses search, `Esc` closes the panel.

## Options

```
-o, --out <file>       output file            (default release-graph.html)
    --json <file>      also write the raw model as JSON
    --remote <name>    remote to read         (default origin)
    --branches <list>  integration branches   (default: auto-detect git-flow)
    --tag-pattern <re> only tags matching this regex
    --prerelease       include prerelease tags (1.8.0-rc.1)
    --limit <n>        only the newest N releases
    --since <date>     ignore history older than this (e.g. "2 years ago")
    --github           enrich from the GitHub Releases API (GITHUB_TOKEN or gh)
    --no-fetch         skip "git fetch --tags"
    --no-open          do not open the result in a browser
```

The `--json` output is the whole model — verdicts, lineage, per-PR status — if
you would rather build your own report or gate CI on it.

## How it decides things

- **Releases** are semver tags (`v1.8.0`, `1.8.0`, `1.8.0-rc.1`), ordered by the
  date of the *commit they point at*, not by version number — so parallel
  maintenance lines (1.9.16 released after 2.0.0) stay in honest order.
- **Pull requests** come from commit subjects, entirely offline: GitHub merge
  commits (`Merge pull request #123 from …`), GitHub squash merges
  (`title (#123)`), and Bitbucket (`Merged in x (pull request #123)`).
- **Presence** is exact commit reachability first; failing that, the same PR
  *number* appearing on the target counts as an equivalent (a squash or a
  cherry-pick).
- **A tag is not its content.** Release tags routinely point at a version-bump
  commit that was never merged anywhere, while the work they name shipped long
  before. Those are reported as release-prep noise and excluded from the
  verdicts rather than raised as alarms.
- **Integration branches** are auto-detected from `develop`, `development`,
  `main`, `master`, `trunk`, plus the remote's HEAD. Release branches match
  `release/*`, `release-*`, `hotfix/*`, `hotfix-*`, `support/*`.

## Limits worth knowing

- **"Not in your newest release" is a hypothesis, not a verdict.** The tool
  proves a commit is absent. It cannot tell absence caused by a dropped
  backport from absence caused by work that was reimplemented, superseded or
  deliberately reverted. Read the list before acting on it.
- **Equivalence is matched by PR number, not by patch content.** Git's own
  `git cherry` / `git log --cherry-mark` use patch-ids and will catch
  rebased or cherry-picked commits that this misses. If your team rewrites
  commit subjects on backport, expect false "absent" results.
- **PR detection depends on your merge style.** Repos that rebase-merge with
  no PR reference in the subject will show releases with commits but no pull
  requests. The commit counts stay correct.
- **Ownership is a heuristic.** A commit is attributed to the earliest release,
  chronologically, whose history contains it. At a fork this is a judgement
  call, not a fact.
- `--github` works unauthenticated on public repos (60 requests/hour). Set
  `GITHUB_TOKEN`, or be logged into `gh`, for private repos or a higher rate
  limit. Releases with more than 100 published entries are untested.
- Needs a full clone. On a shallow one, pass `--since` or fetch more history.
- Tested against git-flow (`develop` + `master` + `release-*`) and trunk-based
  (`main` only) repositories.

## Requirements

Node 18+ and `git` on PATH. Everything runs locally; nothing is uploaded. The
page pulls its webfonts from Google Fonts and degrades to system fonts offline —
`--github` is the only flag that makes a network request of its own.

## Development

```bash
npm test        # unit tests for version parsing, PR parsing, reachability
```

```
src/cli.js            argument parsing, orchestration
src/git.js            git plumbing (one topo-ordered commit-graph pass)
src/lineage.js        bitset reachability: which releases contain a commit
src/model.js          releases, ownership, verdicts
src/github.js         optional GitHub Releases enrichment
src/render.js         inlines CSS + JS + JSON into one HTML file
src/client/           the SVG renderer and stylesheet
```

## License

MIT
