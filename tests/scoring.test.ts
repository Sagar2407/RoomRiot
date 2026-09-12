import { describe, it, expect } from 'vitest';
import { toNightPoints } from '@roomriot/game-core';

describe('Night Points (blueprint §6)', () => {
  it('reproduces the worked example: 240/180/180/60 out of 300 → 85/58/58/15', () => {
    const np = toNightPoints(
      [
        { memberId: 'a', raw: 240 },
        { memberId: 'b', raw: 180 },
        { memberId: 'c', raw: 180 },
        { memberId: 'd', raw: 60 },
      ],
      300,
    );
    const points = Object.fromEntries(np.map((e) => [e.memberId, e.nightPoints]));
    expect(points).toEqual({ a: 85, b: 58, c: 58, d: 15 });
  });

  it('gives tied players equal placement and points', () => {
    const np = toNightPoints(
      [
        { memberId: 'a', raw: 100 },
        { memberId: 'b', raw: 100 },
        { memberId: 'c', raw: 100 },
      ],
      100,
    );
    // Equal raw ⇒ full performance (100) and mid placement (50):
    // round(0.75·100 + 0.25·50) = 88, identical for everyone.
    for (const e of np) {
      expect(e.placement).toBe(50);
      expect(e.nightPoints).toBe(88);
    }
  });

  it('never exceeds 100 and floors at 0', () => {
    const np = toNightPoints(
      [
        { memberId: 'a', raw: 300 },
        { memberId: 'b', raw: 0 },
      ],
      300,
    );
    expect(np.find((e) => e.memberId === 'a')!.nightPoints).toBe(100);
    expect(np.find((e) => e.memberId === 'b')!.nightPoints).toBe(0);
  });

  it('handles a single eligible player (placement undefined → performance only)', () => {
    const np = toNightPoints([{ memberId: 'a', raw: 150 }], 300);
    expect(np[0]!.nightPoints).toBe(50);
  });

  it('rejects a non-positive maximum', () => {
    expect(() => toNightPoints([{ memberId: 'a', raw: 1 }], 0)).toThrow();
  });
});
