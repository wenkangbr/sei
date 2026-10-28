/**
 * How an explicit "restart to update" hands off to the installer (261023).
 *
 * Pure (no electron import) so it unit-tests on any host; updater.ts spreads
 * the result into `autoUpdater.quitAndInstall(...)`.
 *
 * Windows (NsisUpdater): electron-updater turns the two flags into installer
 * arguments. BaseUpdater.quitAndInstall(isSilent, isForceRunAfter) calls
 * `install(isSilent, isSilent ? isForceRunAfter : autoRunAppAfterInstall)`,
 * and NsisUpdater.doInstall builds `["--updated", "/S"?, "--force-run"?]`.
 *   - quitAndInstall() (the old call) = `--updated --force-run`: the one-click
 *     installer is NOT silent, so it shows its "Installing, please wait"
 *     SpiderBanner window until it relaunches Sei.
 *   - quitAndInstall(true, true) = `--updated /S --force-run`: no installer
 *     window at all, and Sei still relaunches itself when the files are in
 *     (installSection.nsh: RUN_AFTER_FINISH + `${isForceRun}` -> doStartApp).
 *   The update-on-quit path (autoInstallOnAppQuit) stays `--updated /S` with
 *   no relaunch; electron-updater's quit handler does that, not this helper.
 *
 * macOS (MacUpdater): quitAndInstall() takes no arguments; Squirrel.Mac swaps
 * the bundle and relaunches because autoRunAppAfterInstall defaults to true.
 * Linux is not shipped; the defaults are fine there.
 */
export type QuitAndInstallArgs = [] | [isSilent: boolean, isForceRunAfter: boolean];

export function restartInstallArgs(platform: NodeJS.Platform): QuitAndInstallArgs {
  if (platform === 'win32') return [true, true];
  return [];
}
