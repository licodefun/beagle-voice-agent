import test from 'node:test';
import assert from 'node:assert/strict';
import { callIntent } from '../lib/text-intent.js';

test('call requests hit', () => {
  for (const s of ['call me', 'Call me again?', 'can you call me', 'please call me now', 'give me a call', '打给我', '给我打电话', '你给我打个电话吧', '打电话给我']) {
    assert.equal(callIntent(s), true, s);
  }
});

test('call talk does not dial', () => {
  for (const s of ['I called you yesterday', 'the call quality was bad', 'did you call Rio?', 'recall me the story', '你打给Rio了吗', '刚才的电话怎么样', 'Tell me what is beagle chat', 'Are you crashed?']) {
    assert.equal(callIntent(s), false, s);
  }
});
