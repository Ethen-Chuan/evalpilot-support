import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GALLERY_PAGE_SIZE, galleryPage, imageGroups } from '../src/visionGallery.ts';
import photoManifest from '../backend/public_vision/photo-manifest.json' with { type: 'json' };

const sample = (id: string, hash = id, suite = 'public') => ({ id, title: `Case ${id}`, assetId: `asset-${id}`, assetHash: hash, suite, imageAvailable: true });
const crops = [
  sample('crop-1', 'b504f8bc6096fe1dcdad816285a368cc85b262858052f57543d3e13ae5210c53'),
  sample('crop-2', 'f486757dbdb09fecc594f39c3a08e6210372fb4a11a8b5ccd580b3a2ddf65974'),
  sample('crop-3', '6f3a11a016f9c76839bf27c9c9952a1ba481def98c6022696ca1b7ff674c72f8'),
  sample('crop-4', '9dc83f963c297ac59380797683e3e7f4853d1846e057598f212c8decbd53d04b'),
];

test('24 reviewed PCB photos form four groups without losing cases', () => {
  const cases = [...crops, ...photoManifest.map(photo => sample(photo.file, photo.sha256))];
  const groups = imageGroups(cases);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.map(group => group.cases.length).sort(), [5, 6, 6, 7]);
  assert.equal(new Set(groups.flatMap(group => group.cases.map(item => item.id))).size, 24);
  assert.ok(groups.every(group => group.cover.id.startsWith('board-')));
  assert.equal(galleryPage(groups, 1).items.length, 4);
});

test('grouping pins match the actual normalized public photos', () => {
  for (const photo of photoManifest) {
    const bytes = readFileSync(new URL(`../backend/public_vision/${photo.file}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), photo.sha256);
  }
});

test('identical images with different questions use one cover and retain questions', () => {
  const groups = imageGroups([sample('one', 'same'), sample('two', 'same'), sample('three')]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].cases.map(item => item.id), ['one', 'two']);
});

test('unrecognized images and separate sources are never falsely merged as similar', () => {
  assert.equal(imageGroups([sample('one', photoManifest[0].sha256, 'real'), sample('two', photoManifest[1].sha256, 'real')]).length, 2);
  assert.equal(imageGroups([sample('one', 'same', 'real'), sample('two', 'same', 'calibration')]).length, 2);
  assert.equal(imageGroups([sample('one'), sample('two')]).length, 2);
});

test('missing hashes use asset identity rather than merge missing metadata', () => {
  assert.equal(imageGroups([sample('one', ''), sample('two', '')]).length, 2);
  assert.equal(imageGroups([{ ...sample('one', ''), assetId: '' }, { ...sample('two', ''), assetId: '' }]).length, 2);
});

test('available photos win over unavailable covers and originals win over crops', () => {
  const cases = [{ ...sample('original', photoManifest[0].sha256), imageAvailable: false }, crops[0]];
  assert.equal(imageGroups(cases)[0].cover.id, 'crop-1');
  assert.equal(imageGroups([...cases, sample('available-original', photoManifest[0].sha256)])[0].cover.id, 'available-original');
});

test('pages contain nine groups without padding, overlap, or missing tail entries', () => {
  const items = Array.from({ length: 23 }, (_, index) => `item-${index}`);
  const pages = [1, 2, 3].map(page => galleryPage(items, page));
  assert.equal(GALLERY_PAGE_SIZE, 9);
  assert.deepEqual(pages.map(value => value.items.length), [9, 9, 5]);
  assert.deepEqual(pages.flatMap(value => value.items), items);
  assert.equal(galleryPage(items, 99).page, 3);
  assert.equal(galleryPage(items, 0).page, 1);
  assert.equal(galleryPage(items, NaN).page, 1);
  assert.deepEqual(galleryPage([], 5), { page: 1, pages: 1, items: [] });
});
