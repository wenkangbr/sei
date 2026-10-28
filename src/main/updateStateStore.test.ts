import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('./paths', () => ({
  paths: {
    userData: () => h.userData,
    updateStatePath: () => path.join(h.userData, 'update-state.json'),
  },
}));

import { loadUpdateState, saveUpdateState } from './updateStateStore';

describe('updateStateStore pending.brief', () => {
  beforeEach(async () => {
    h.userData = await mkdtemp(path.join(tmpdir(), 'sei-update-state-'));
  });
  afterEach(async () => {
    await rm(h.userData, { recursive: true, force: true });
  });

  it('round-trips brief: true for an accepted optional update', async () => {
    await saveUpdateState({
      version: 1,
      lastSeenVersion: '0.7.0',
      pending: { version: '0.8.0', changelog: '- New thing', brief: true },
    });
    const s = await loadUpdateState();
    expect(s.pending).toEqual({ version: '0.8.0', changelog: '- New thing', brief: true });
  });

  it('keeps mandatory stashes without the flag', async () => {
    await saveUpdateState({
      version: 1,
      lastSeenVersion: '0.7.0',
      pending: { version: '0.7.1', changelog: '- Fix' },
    });
    const s = await loadUpdateState();
    expect(s.pending).toEqual({ version: '0.7.1', changelog: '- Fix' });
    expect(s.pending && 'brief' in s.pending).toBe(false);
  });

  it('drops a non-boolean brief from an older or hand-edited file', async () => {
    await writeFile(
      path.join(h.userData, 'update-state.json'),
      JSON.stringify({ version: 1, lastSeenVersion: null, pending: { version: '1.0.0', changelog: '', brief: 'yes' } }),
    );
    const s = await loadUpdateState();
    expect(s.pending).toEqual({ version: '1.0.0', changelog: '' });
  });
});
