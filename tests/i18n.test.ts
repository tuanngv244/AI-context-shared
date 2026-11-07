import { test } from 'node:test';
import assert from 'node:assert/strict';
import dictionary from '../apps/dashboard/app/i18n/messages.js';
const { messages, translate } = dictionary;
test('every UI message has English and Vietnamese with matching interpolation fields', () => {
  for (const [key, value] of Object.entries(messages)) {
    assert.ok(value.en.length, key);
    assert.ok(value.vi.length, key);
    const fields = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(fields(value.en), fields(value.vi), key);
  }
});
test('translations preserve interpolated repo names and can relocalize existing error messages', () => {
  assert.equal(translate('en', 'Kết nối workspace'), 'Connect workspace');
  assert.equal(translate('vi', 'Kết nối workspace'), 'Kết nối workspace');
  assert.equal(
    translate('vi', translate('en', 'Token không đúng. Copy nội dung .local/dev-token.')),
    'Token không đúng. Copy nội dung .local/dev-token.',
  );
  assert.ok(
    translate('en', 'recallPrompt', { repository: 'repo-đặc-biệt' }).includes('repo-đặc-biệt'),
  );
  assert.equal(translate('en', 'memoryCountOne', { count: 1 }), '1 memory');
});
