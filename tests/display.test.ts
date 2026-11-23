import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { pickDisplayMode, type DisplayMode } from '../src/host/display-mode.ts';

const modes: DisplayMode[] = [
  { width: 1920, height: 1080, refreshRate: 60 },
  { width: 1920, height: 1080, refreshRate: 144 },
  { width: 2560, height: 1440, refreshRate: 60 },
  { width: 2560, height: 1440, refreshRate: 165 },
  { width: 3840, height: 2160, refreshRate: 60 },
  { width: 3840, height: 2160, refreshRate: 120 },
  { width: 1280, height: 1024, refreshRate: 60 },
  { width: 1600, height: 1200, refreshRate: 60 },
  { width: 2048, height: 1536, refreshRate: 60 },
];

describe('display mode selection', () => {
  test('an exact pixel match wins over any larger mode', () => {
    const picked = pickDisplayMode(modes, { width: 1920, height: 1080, fps: 60 });
    assert.deepEqual(picked, { width: 1920, height: 1080, refreshRate: 60 });
  });

  test('picks the refresh rate closest to the session fps', () => {
    assert.equal(pickDisplayMode(modes, { width: 2560, height: 1440, fps: 60 })?.refreshRate, 60);
    assert.equal(pickDisplayMode(modes, { width: 2560, height: 1440, fps: 144 })?.refreshRate, 165);
    assert.equal(pickDisplayMode(modes, { width: 3840, height: 2160, fps: 120 })?.refreshRate, 120);
  });

  test('without an exact mode, chooses the smallest one that still covers the controller', () => {
    // 3/4 of 4K: only 2560x1440 covers it, so the encoder runs 1:1 there and the
    // controller shrinks slightly instead of the host encoding 4K for nothing.
    const picked = pickDisplayMode(modes, { width: 2880, height: 1620, fps: 60 });
    assert.deepEqual(picked, { width: 3840, height: 2160, refreshRate: 60 });
  });

  test('a phone aspect the panel cannot express keeps the old downscale path', () => {
    // 2400x1080 is 20:9; no listed mode is within tolerance, so the host must not
    // change resolution at all.
    assert.equal(pickDisplayMode(modes, { width: 2400, height: 1080, fps: 60 }), null);
    assert.equal(pickDisplayMode(modes, { width: 2392, height: 1080, fps: 60 }), null);
  });

  test('a 4:3 tablet larger than every 4:3 mode falls back to the largest one', () => {
    const picked = pickDisplayMode(modes, { width: 2732, height: 2048, fps: 60 });
    assert.deepEqual(picked, { width: 2048, height: 1536, refreshRate: 60 });
  });

  test('refuses a downgrade that would halve the desktop', () => {
    const small: DisplayMode[] = [{ width: 1024, height: 768, refreshRate: 60 }];
    assert.equal(pickDisplayMode(small, { width: 2732, height: 2048, fps: 60 }), null);
  });

  test('degenerate input yields no change', () => {
    assert.equal(pickDisplayMode([], { width: 1920, height: 1080 }), null);
    assert.equal(pickDisplayMode(modes, { width: 0, height: 1080 }), null);
  });
});
