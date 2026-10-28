/**
 * The voice-call transcript window (261024). The window's first row is the
 * start of the cached transcript prefix, so it must stay put across turns and
 * only move in whole steps, counted on absolute transcript positions.
 */
import { describe, it, expect } from 'vitest';
import { voiceWindowStart } from './transcript';
import type { ChatMessage } from '../../shared/ipc';

/** A transcript of `n` alternating user/companion rows; row text = absolute position. */
function rows(n: number, from = 0): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${from + i}`,
    role: (from + i) % 2 === 0 ? 'user' : 'companion',
    text: String(from + i),
    ts: 1_700_000_000_000 + (from + i) * 1000,
  })) as ChatMessage[];
}

/** Absolute position of the first row the window keeps. */
const firstKept = (h: ChatMessage[], base: number): number => Number(h[voiceWindowStart(h, base, 10, 10)].text);

describe('voiceWindowStart', () => {
  it('sends everything while the history is within the cap', () => {
    for (let n = 0; n <= 10; n++) expect(voiceWindowStart(rows(n), 0, 10, 10)).toBe(0);
  });

  it('keeps between cap and cap + step - 1 rows', () => {
    for (let n = 10; n < 200; n++) {
      const h = rows(n);
      const kept = n - voiceWindowStart(h, 0, 10, 10);
      expect(kept).toBeGreaterThanOrEqual(10);
      expect(kept).toBeLessThanOrEqual(19);
    }
  });

  it('holds the same first row for step turns in a row, then jumps by step', () => {
    const starts = Array.from({ length: 40 }, (_, i) => firstKept(rows(10 + i), 0));
    expect(starts.slice(0, 10).every((s) => s === 0)).toBe(true);
    expect(starts.slice(10, 20).every((s) => s === 10)).toBe(true);
    expect(starts.slice(20, 30).every((s) => s === 20)).toBe(true);
  });

  it('stays on the same absolute row when a fold drops a batch from the front', () => {
    for (let n = 60; n < 150; n++) {
      // Before the fold: the whole transcript. After: the first 50 rows are summarized.
      expect(firstKept(rows(n - 50, 50), 50)).toBe(firstKept(rows(n), 0));
    }
  });

  it('does not slide when the tail is capped at a constant length (folds failing)', () => {
    // readWindow caps the tail at the newest 150 rows, so history.length stays
    // 150 while its front (base) advances by one each turn.
    const starts: number[] = [];
    for (let total = 200; total < 230; total++) {
      const base = total - 150;
      starts.push(firstKept(rows(150, base), base));
    }
    // One distinct start per 10 turns, each a multiple of the step.
    expect(new Set(starts).size).toBeLessThanOrEqual(4);
    for (const s of starts) expect(s % 10).toBe(0);
    for (let i = 1; i < starts.length; i++) {
      const changed = starts[i] !== starts[i - 1];
      if (changed) expect(starts[i] - starts[i - 1]).toBe(10);
    }
  });

  it('counts only user/companion rows, and keeps system rows inside the window', () => {
    const h = rows(25);
    // A play row in the middle of the window.
    h.splice(20, 0, { id: 'p', role: 'system', text: 'played', ts: 0, event: { kind: 'play' } } as unknown as ChatMessage);
    const start = voiceWindowStart(h, 0, 10, 10);
    const kept = h.slice(start);
    expect(kept[0].text).toBe('10');
    expect(kept.filter((m) => m.role !== 'system')).toHaveLength(15);
    expect(kept.some((m) => m.role === 'system')).toBe(true);
  });

  it('treats a step below 1 as 1 (the old sliding window)', () => {
    expect(firstKept(rows(25), 0)).toBe(10);
    const h = rows(25);
    expect(Number(h[voiceWindowStart(h, 0, 10, 0)].text)).toBe(15);
  });
});
