/**
 * 261023: the sidebar "Update Sei" button. SSR renders read a zustand store's
 * INITIAL state, so the update store is a plain selector over a mutable
 * object here; the session stores are the real ones (nothing live).
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateRailState } from '../lib/stores/useUpdateStore';

vi.mock('../lib/ipcClient', () => ({ sei: {} }));
const update: { rail: UpdateRailState | null; restart: () => void } = { rail: null, restart: () => undefined };
vi.mock('../lib/stores/useUpdateStore', () => ({
  useUpdateStore: Object.assign((sel: (s: typeof update) => unknown) => sel(update), { getState: () => update }),
}));

const { UpdateRailButton, liveSessionForRestart } = await import('./UpdateRailButton');

const render = (rail: UpdateRailState | null): string => {
  update.rail = rail;
  return renderToStaticMarkup(<UpdateRailButton />);
};

describe('UpdateRailButton', () => {
  it('renders nothing without an update', () => {
    expect(render(null)).toBe('');
  });

  it('shows a calm progress bar while downloading, with no button', () => {
    const html = render({ kind: 'downloading', percent: 41.6 });
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).not.toContain('<button');
  });

  it('shows the Update Sei button when ready, naming the version', () => {
    const html = render({ kind: 'ready', version: '0.7.0' });
    expect(html).toMatch(/<button[^>]*>/);
    expect(html).toContain('Update Sei');
    expect(html).toContain('Restart into Sei 0.7.0');
    expect(html).not.toContain('disabled');
  });

  it('disables the button while restarting', () => {
    const html = render({ kind: 'restarting', version: '0.7.0' });
    expect(html).toContain('disabled');
    expect(html).toContain('Restarting');
  });
});

describe('liveSessionForRestart', () => {
  const idle = { callStatus: 'idle', summons: {}, chessGames: {}, backseat: {}, drawGames: {} };

  it('is null when nothing is running', () => {
    expect(liveSessionForRestart(idle)).toBeNull();
    expect(liveSessionForRestart({ ...idle, chessGames: { a: { status: 'ended' } }, drawGames: { a: { phase: 'gallery' } } })).toBeNull();
  });

  it('reports a call first', () => {
    expect(liveSessionForRestart({ ...idle, callStatus: 'live', summons: { a: { kind: 'online' } } })).toBe('call');
    expect(liveSessionForRestart({ ...idle, callStatus: 'connecting' })).toBe('call');
  });

  it('reports a companion bot, chess, screen share or Draw! turn as a session', () => {
    expect(liveSessionForRestart({ ...idle, summons: { a: { kind: 'connecting' } } })).toBe('session');
    expect(liveSessionForRestart({ ...idle, chessGames: { a: { status: 'active' } } })).toBe('session');
    expect(liveSessionForRestart({ ...idle, backseat: { a: true } })).toBe('session');
    expect(liveSessionForRestart({ ...idle, drawGames: { a: { phase: 'drawing' } } })).toBe('session');
  });
});
