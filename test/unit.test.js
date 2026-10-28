import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersion, versionLabel, parsePR, normTitle } from '../src/model.js';
import { buildBitsets } from '../src/lineage.js';

test('parseVersion accepts the shapes real repos tag with', () => {
  assert.deepEqual(parseVersion('v1.8.0'), { major: 1, minor: 8, patch: 0, pre: '' });
  assert.deepEqual(parseVersion('1.8.0'), { major: 1, minor: 8, patch: 0, pre: '' });
  assert.deepEqual(parseVersion('v2.0'), { major: 2, minor: 0, patch: 0, pre: '' });
  assert.equal(parseVersion('v1.8.0-rc.1').pre, 'rc.1');
  assert.equal(parseVersion('release-2024'), null);
  assert.equal(parseVersion('nightly'), null);
});

test('compareVersion orders prereleases before their release', () => {
  const v = (s) => parseVersion(s);
  assert.ok(compareVersion(v('v1.8.0-rc.1'), v('v1.8.0')) < 0);
  assert.ok(compareVersion(v('v1.8.0-rc.2'), v('v1.8.0-rc.10')) < 0, 'numeric, not lexical');
  assert.ok(compareVersion(v('v1.9.16'), v('v2.0.0')) < 0);
  assert.equal(compareVersion(v('v1.8.0'), v('1.8.0')), 0);
  assert.equal(versionLabel(v('v1.8.0-rc.1')), '1.8.0-rc.1');
});

test('parsePR reads the three merge styles', () => {
  assert.deepEqual(
    parsePR({ subject: 'Merge pull request #123 from org/branch', body: 'Add the thing' }),
    { number: 123, title: 'Add the thing', head: 'org/branch', style: 'merge' });
  assert.deepEqual(
    parsePR({ subject: 'fix(testland): raise timeouts (#13577)', body: '' }),
    { number: 13577, title: 'fix(testland): raise timeouts', head: null, style: 'squash' });
  assert.equal(parsePR({ subject: 'Merged in feat-x (pull request #77)', body: '' }).number, 77);
  assert.equal(parsePR({ subject: "Merge branch 'develop' into feature", body: '' }), null);
  assert.equal(parsePR({ subject: 'plain commit, no PR', body: '' }), null);
});

test('parsePR falls back to the head branch when the body is empty', () => {
  const pr = parsePR({ subject: 'Merge pull request #9 from acme/hotfix', body: '' });
  assert.equal(pr.title, 'acme/hotfix');
});

/* a --- b --- c        (c tagged "r1")
        \
         d --- e        (e tagged "r2")            */
function fixture() {
  const g = new Map();
  const add = (sha, parents) => g.set(sha, { sha, parents, date: 1, author: 'x', subject: '', body: '' });
  add('e', ['d']); add('c', ['b']); add('d', ['b']); add('b', ['a']); add('a', []);
  return g;
}

test('buildBitsets floods reachability from tips to roots', () => {
  const g = fixture();
  const bs = buildBitsets(g, [{ sha: 'c' }, { sha: 'e' }]);
  assert.ok(bs.has('a', 0) && bs.has('a', 1), 'the root is in both releases');
  assert.ok(bs.has('b', 0) && bs.has('b', 1), 'the fork point is in both');
  assert.ok(bs.has('c', 0) && !bs.has('c', 1), 'c is only in r1');
  assert.ok(bs.has('e', 1) && !bs.has('e', 0), 'e is only in r2');
  assert.equal(bs.has('nope', 0), false, 'unknown sha is not reachable');
});

test('buildBitsets handles more than 32 marks', () => {
  const g = fixture();
  const marks = Array.from({ length: 40 }, () => ({ sha: 'c' }));
  const bs = buildBitsets(g, marks);
  assert.ok(bs.has('a', 39), 'bit 39 crosses into the second word');
  assert.ok(bs.has('a', 0));
});

test('normTitle strips backport markers so a backport matches its original', () => {
  assert.equal(normTitle('[release-3.6] Fix race in read index (#21378)'), 'fix race in read index');
  assert.equal(normTitle('[3.5] Fix ts with no trailing zeros'), 'fix ts with no trailing zeros');
  assert.equal(normTitle('backport-3.5: server: skip sprintf'), 'server: skip sprintf');
  assert.equal(normTitle('release-3.5: fix x'), 'fix x');
  assert.equal(normTitle('fix(mocker): hoist vi.mock() [backport to v4]'), 'fix(mocker): hoist vi.mock()');
  assert.equal(normTitle('Update dep: yaml v2.4.0 [release 3.5]'), 'update dep: yaml v2.4.0');
  assert.equal(normTitle('fix: keep [brackets] mid-title'), 'fix: keep [brackets] mid-title');
});

test('patchEquivalents finds a backport by its content alone', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { patchEquivalents } = await import('../src/patchid.js');
  const { commitGraph } = await import('../src/git.js');

  const dir = mkdtempSync(join(tmpdir(), 'rg-patchid-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (file, body, msg) => { writeFileSync(join(dir, file), body); git('add', file); git('commit', '-qm', msg); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  commit('a.txt', 'one\ntwo\nthree\n', 'base');
  git('branch', 'release-1.0');
  const original = commit('a.txt', 'one\nTWO\nthree\n', 'fix two (#10)');
  git('checkout', '-q', 'release-1.0');
  // reworded, no PR number in common: nothing but the content ties it to #10
  const backport = commit('a.txt', 'one\nTWO\nthree\n', 'Port the 2 fix to the old line (#11)');
  const unrelated = commit('b.txt', 'only here\n', 'line-only tweak (#12)');

  const graph = await commitGraph(dir, ['main', 'release-1.0']);
  const bs = buildBitsets(graph, [{ sha: git('rev-parse', 'main') }]);
  const prs = [{ sha: backport, style: 'squash' }, { sha: unrelated, style: 'squash' }];
  const found = await patchEquivalents(dir, graph, bs, prs, [0], ['main'], null);
  assert.ok(found.has(prs[0]), 'the reworded backport is found on main');
  assert.ok(!found.has(prs[1]), 'a line-only change is not');
  assert.ok(bs.has(original, 0));
});
