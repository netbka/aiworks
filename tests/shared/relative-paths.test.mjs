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
