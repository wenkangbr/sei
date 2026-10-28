import { describe, expect, it } from 'vitest';
import { restartInstallArgs } from './updateInstall';

describe('restartInstallArgs', () => {
  it('runs the Windows installer silently and relaunches Sei', () => {
    // NsisUpdater maps (true, true) to `--updated /S --force-run`.
    expect(restartInstallArgs('win32')).toEqual([true, true]);
  });

  it('leaves macOS on the default call (Squirrel relaunches on its own)', () => {
    expect(restartInstallArgs('darwin')).toEqual([]);
  });

  it('leaves Linux on the defaults', () => {
    expect(restartInstallArgs('linux')).toEqual([]);
  });
});
