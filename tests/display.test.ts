import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { pickDisplayMode, type DisplayMode } from '../src/host/display-mode.ts';
import {
  primaryDisplayIndex,
  virtualBounds,
  type HostDisplay,
} from '../src/host/display.ts';
import { frameToVirtual } from '../src/host/injector.ts';
import { decodeControl, encodeControl } from '../src/protocol/messages.ts';

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

describe('multi-display geometry', () => {
  // Primary in the middle, one panel to its right, one rotated panel to its
  // left (negative origin) — the layout that breaks naive 0,0 assumptions.
  const dual: HostDisplay[] = [
    { index: 0, name: 'DISPLAY1', primary: true, x: 0, y: 0, width: 1920, height: 1080, refreshRate: 144 },
    { index: 1, name: 'DISPLAY2', primary: false, x: 1920, y: 0, width: 2560, height: 1440, refreshRate: 60 },
    { index: 2, name: 'DISPLAY3', primary: false, x: -1080, y: 120, width: 1080, height: 1920, refreshRate: 60 },
  ];

  test('finds the primary wherever it sits in the list', () => {
    assert.equal(primaryDisplayIndex(dual), 0);
    const moved = dual.map((d, i) => ({ ...d, primary: i === 2 }));
    assert.equal(primaryDisplayIndex(moved), 2);
    assert.equal(primaryDisplayIndex([]), 0);
  });

  test('virtual bounds cover every panel, negative origins included', () => {
    assert.deepEqual(virtualBounds(dual), { x: -1080, y: 0, width: 5560, height: 2040 });
    assert.deepEqual(virtualBounds([dual[0]!]), { x: 0, y: 0, width: 1920, height: 1080 });
  });

  test('frame coordinates map into the selected display only', () => {
    const virtual = virtualBounds(dual);
    const right = dual[1]!;
    const rect = { x: right.x, y: right.y, width: right.width, height: right.height };
    // Frame edges land exactly on the monitor's edges in virtual space.
    const left = frameToVirtual(0, 0, rect, virtual);
    assert.deepEqual(left, {
      nx: Math.round(((right.x - virtual.x) / virtual.width) * 65535),
      ny: 0,
    });
    const corner = frameToVirtual(65535, 65535, rect, virtual);
    assert.equal(corner.nx, Math.round(((right.x + right.width - virtual.x) / virtual.width) * 65535));
    assert.equal(corner.ny, Math.round(((right.y + right.height - virtual.y) / virtual.height) * 65535));
    // Nothing the controller sends can cross into a neighbouring panel:
    // out-of-range fractions clamp to the frame edge first.
    const wild = frameToVirtual(999_999, -5, rect, virtual);
    assert.ok(wild.nx <= corner.nx && wild.ny >= left.ny);
  });

  test('a display left of the primary maps from the virtual origin', () => {
    const virtual = virtualBounds(dual);
    const leftPanel = dual[2]!;
    const rect = { x: leftPanel.x, y: leftPanel.y, width: leftPanel.width, height: leftPanel.height };
    assert.equal(frameToVirtual(0, 0, rect, virtual).nx, 0);
    // Its right edge is exactly the primary's left edge — adjacent, never past it.
    assert.equal(
      frameToVirtual(65535, 0, rect, virtual).nx,
      frameToVirtual(0, 0, dual[0]!, virtual).nx,
    );
  });

  test('single-screen mapping is the identity', () => {
    const only = dual[0]!;
    const rect = { x: 0, y: 0, width: only.width, height: only.height };
    assert.deepEqual(frameToVirtual(0, 0, rect, rect), { nx: 0, ny: 0 });
    assert.deepEqual(frameToVirtual(65535, 65535, rect, rect), { nx: 65535, ny: 65535 });
    const mid = frameToVirtual(32768, 32768, rect, rect);
    assert.ok(Math.abs(mid.nx - 32768) <= 1 && Math.abs(mid.ny - 32768) <= 1);
  });
});

describe('display control messages', () => {
  test('displays and select-display survive the wire round trip', () => {
    const list = decodeControl(
      encodeControl({
        t: 'displays',
        displays: [
          { index: 0, name: 'DISPLAY1', primary: true, width: 1920, height: 1080, refreshRate: 144 },
          { index: 1, name: 'DISPLAY2', primary: false, width: 2560, height: 1440, refreshRate: 60 },
        ],
        active: 0,
      }),
    );
    assert.equal(list?.t, 'displays');
    if (list?.t === 'displays') {
      assert.equal(list.displays.length, 2);
      assert.equal(list.displays[1]?.width, 2560);
      assert.equal(list.active, 0);
    }
    const pick = decodeControl(encodeControl({ t: 'select-display', index: 1 }));
    assert.equal(pick?.t, 'select-display');
    if (pick?.t === 'select-display') assert.equal(pick.index, 1);
  });
});
