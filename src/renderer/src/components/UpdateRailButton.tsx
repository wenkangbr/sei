/**
 * UpdateRailButton: the "Update Sei" bar pinned to the bottom of the sidebar
 * (261023, Telegram's "Update Telegram" footer is the reference).
 *
 * Replaces the corner UpdatePill. A ready update used to be a small card with
 * "Restart now" / "Later" that was easy to dismiss and forget; now it is a
 * full-width, high-contrast block at the foot of the rail that stays until
 * the update is installed. One click restarts into the new version (on
 * Windows the installer runs silently and reopens Sei, see
 * src/main/updateInstall.ts).
 *
 *   downloading  quiet: a hairline progress bar, no click target. Downloads
 *                stay background work (a mandatory patch download was never
 *                asked for, so it must not shout).
 *   ready        the gradient button.
 *   restarting   same button, spinning icon, disabled.
 *
 * A click while a call, a Minecraft companion, or a game is live asks first,
 * because the restart ends it. Otherwise it restarts straight away.
 */
import React, { useState } from 'react';
import type { DrawGameState } from '@shared/drawIpc';
import { useT } from '../lib/i18n';
import { useUpdateStore } from '../lib/stores/useUpdateStore';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useChessStore } from '../lib/stores/useChessStore';
import { useBackseatStore } from '../lib/stores/useBackseatStore';
import { useDrawStore } from '../lib/stores/useDrawStore';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { RefreshIcon } from './icons';
import styles from './UpdateRailButton.module.css';

/** What a restart would interrupt right now, for the confirm copy. */
export type LiveSession = 'call' | 'session' | null;

export interface LiveSessionInputs {
  callStatus: string;
  summons: Readonly<Record<string, { kind: string } | undefined>>;
  chessGames: Readonly<Record<string, { status: string } | null | undefined>>;
  backseat: Readonly<Record<string, boolean | undefined>>;
  drawGames: Readonly<Record<string, Pick<DrawGameState, 'phase'> | undefined>>;
}

/** Pure so it tests without mounting anything. A call wins over a game. */
export function liveSessionForRestart(s: LiveSessionInputs): LiveSession {
  if (s.callStatus === 'live' || s.callStatus === 'connecting') return 'call';
  const bot = Object.values(s.summons).some((v) => v?.kind === 'online' || v?.kind === 'connecting');
  const chess = Object.values(s.chessGames).some((g) => g != null && g.status !== 'ended');
  const watching = Object.values(s.backseat).some((v) => v === true);
  const drawing = Object.values(s.drawGames).some(
    (g) => g != null && (g.phase === 'pick' || g.phase === 'drawing' || g.phase === 'turn-end'),
  );
  return bot || chess || watching || drawing ? 'session' : null;
}

export interface UpdateRailButtonProps {
  /** The rail's shared floating tooltip (label + y anchor), when hosted there. */
  setHover?: (s: { label: string; y: number } | null) => void;
}

export function UpdateRailButton({ setHover }: UpdateRailButtonProps): React.ReactElement | null {
  const t = useT();
  const rail = useUpdateStore((s) => s.rail);
  const restart = useUpdateStore((s) => s.restart);
  const callStatus = useVoiceStore((s) => s.status);
  const summons = useDataStore((s) => s.summons);
  const chessGames = useChessStore((s) => s.games);
  const backseat = useBackseatStore((s) => s.active);
  const drawGames = useDrawStore((s) => s.games);
  const [confirm, setConfirm] = useState<Exclude<LiveSession, null> | null>(null);

  if (!rail) return null;

  if (rail.kind === 'downloading') {
    const pct = Math.max(0, Math.min(100, Math.round(rail.percent)));
    return (
      <div
        className={styles.downloading}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={t('Downloading update, {percent} percent', { percent: pct })}
      >
        <span className={styles.downloadingLabel}>{t('Updating')}</span>
        <span className={styles.track} aria-hidden="true">
          <span className={styles.fill} style={{ width: `${pct}%` }} />
        </span>
      </div>
    );
  }

  const restarting = rail.kind === 'restarting';
  const tip = rail.version
    ? t('Restart into Sei {version}', { version: rail.version })
    : t('Restart into the new version');

  const onClick = (): void => {
    if (restarting) return;
    setHover?.(null);
    const live = liveSessionForRestart({ callStatus, summons, chessGames, backseat, drawGames });
    if (live) {
      setConfirm(live);
      return;
    }
    restart();
  };

  const showTip = (el: HTMLElement): void => {
    if (!setHover || restarting) return;
    const r = el.getBoundingClientRect();
    setHover({ label: tip, y: r.top + r.height / 2 });
  };

  return (
    <>
      <button
        type="button"
        className={`${styles.update} ${restarting ? styles.restarting : ''}`}
        onClick={onClick}
        disabled={restarting}
        aria-label={restarting ? t('Restarting to update') : `${t('Update Sei')}. ${tip}`}
        onMouseEnter={(e) => showTip(e.currentTarget)}
        onMouseLeave={() => setHover?.(null)}
        onFocus={(e) => showTip(e.currentTarget)}
        onBlur={() => setHover?.(null)}
      >
        <span className={styles.icon} aria-hidden="true">
          <RefreshIcon size={20} />
        </span>
        <span className={styles.label}>{restarting ? t('Restarting') : t('Update Sei')}</span>
      </button>

      {confirm ? (
        <ModalShell title={t('Restart to update?')} onClose={() => setConfirm(null)} scrimClose>
          <p className={styles.confirmBody}>
            {confirm === 'call'
              ? t('Sei closes and reopens to finish the update, which ends your call.')
              : t('Sei closes and reopens to finish the update, which ends what your companions are doing right now.')}
          </p>
          <ModalFooter>
            <Button kind="quiet" size="md" onClick={() => setConfirm(null)}>
              {t('Not now')}
            </Button>
            <Button
              kind="primary"
              size="md"
              onClick={() => {
                setConfirm(null);
                restart();
              }}
            >
              {t('Restart and update')}
            </Button>
          </ModalFooter>
        </ModalShell>
      ) : null}
    </>
  );
}
