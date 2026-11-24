import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modifierReleaseLines } from '../src/host/injector.ts';

test('modifier release lines cover every modifier in wire encoding', () => {
  const lines = modifierReleaseLines();
  assert.equal(lines.length, 8);
  for (const line of lines) assert.match(line, /^ku,\d+,\d+$/);
  // Ctrl (left): scan 0x1d, vk 0xa2, no extended bit.
  assert.ok(lines.includes('ku,29,162'));
  // Right Ctrl is an extended key: scan truncates to 0x1d, vk gains 0x100.
  assert.ok(lines.includes('ku,29,419'));
  // Left Alt + right Alt (extended), both shifts, both Win keys.
  assert.ok(lines.includes('ku,56,164'));
  assert.ok(lines.includes('ku,56,421'));
  assert.ok(lines.includes('ku,42,160'));
  assert.ok(lines.includes('ku,54,161'));
  assert.ok(lines.includes('ku,91,347'));
  assert.ok(lines.includes('ku,92,348'));
});
