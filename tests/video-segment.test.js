import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldStop, youtubeId } from '../public/shared/video-player.js';

test('shouldStop', () => {
  assert.equal(shouldStop(12.46, 12.5), true);
  assert.equal(shouldStop(12.3, 12.5), false);
  assert.equal(shouldStop(99, null), false);
});
test('youtubeId', () => {
  assert.equal(youtubeId('https://youtu.be/abc123XYZ_-'), 'abc123XYZ_-');
  assert.equal(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://youtube.com/shorts/dQw4w9WgXcQ?si=1'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://example.com'), null);
});
