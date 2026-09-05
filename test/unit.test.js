import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersion, versionLabel, parsePR } from '../src/model.js';
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
