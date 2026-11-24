import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicationFindings, relativeTo } from '../../src/shared/public-text.mjs';

test('relativeTo cuts only the checkout prefix; a path that climbs out of it keeps its prefix and is refused', () => {
  const roots = [{ path: 'C:\\Wt\\proj', depth: 1 }, { path: 'C:\\Repo\\proj' }];
  const options = { repository: 'example-org/sampleapp' };
  assert.equal(relativeTo('see C:\\Repo\\proj\\src\\a.js and C:/Wt/proj/c1-t1+ab12/web/app.js:12', roots), 'see src\\a.js and web/app.js:12');
  for (const text of [
    'C:\\Repo\\proj\\my dir\\..\\..\\..\\Users\\sample\\notes.txt',
    'C:/Repo/proj/x y/../../../Users/sample/notes.txt',
    'C:/Repo/proj/a.js,../../../Users/sample/notes.txt',
    'C:\\Wt\\proj\\..\\other\\x',
    'C:\\Repo\\proj-other\\x.js',
  ]) {
    const published = relativeTo(text, roots);
    assert.equal(published, text, text);
    assert.notDeepEqual(publicationFindings(published, options), [], text);
  }
});

// A worker in Git Bash writes drive paths as /<drive>/...: such a path was neither cut nor refused, so it reached a public
// PR whole. It is now refused like any drive path, and cut like one when it is under a checkout root; a dashboard hash
// route, a URL or cmd switches written together are not taken for one, so their text is not refused.
test('a path in Git Bash drive form is cut under a root and refused elsewhere; routes, URLs and switches pass', () => {
  const roots = [{ path: 'C:\\Repo\\proj' }];
  const options = { repository: 'example-org/sampleapp' };
  const bash = (...parts) => ['', ...parts].join('/');
  assert.equal(relativeTo(`see ${bash('c', 'Repo', 'proj', 'src', 'a.js')}`, roots), 'see src/a.js');
  for (const text of [bash('d', 'Data', 'notes.txt'), bash('c', 'Users', 'sample', 'notes.txt'), `file://${bash('c', 'Work', 'x')}`, bash('c', 'Repo', 'proj', '..', 'x')]) {
    assert.notDeepEqual(publicationFindings(relativeTo(text, roots), options), [], text);
  }
  for (const text of ['#/p/git/settings', 'http://127.0.0.1:4318/#/p/notes', 'https://example.com/c/Users/x', 'GET /repos/o/r/issues', 'cmd /d/c "npm test"']) {
    assert.deepEqual(publicationFindings(relativeTo(text, roots), options), [], text);
  }
});
