/**
 * ImportLocalProfileModal — offered on a sign-in from the anonymous `local`
 * (own key) profile (260603 per-profile partitioning; 261023 existing accounts).
 *
 * With per-profile partitioning, everything built while signed out stays in
 * the `local` profile when the player signs in. This modal offers to bring it
 * across: their companions (own ones, plus World companions and Sui they had
 * added), the companions' memories, and the name they already entered.
 *
 *   - New account: "Start fresh" declines and goes to onboarding.
 *   - Existing account (261023): the merge adds to the account and replaces
 *     nothing in it. "Not now" leaves the companions on this computer, where
 *     they are offered again on the next sign-in from it.
 *
 * Never offered account→account, so switching between accounts starts fresh.
 * Also offered once at boot to an account that signed in on an older build
 * (App.tsx, checkBootImportOffer), and from Settings → Account.
 *
 * A failed import (261023) keeps the modal up with a short error line and a
 * "Try again"; the import is idempotent, so a retry only redoes what failed.
 *
 * Renders through ModalShell; dismissal is button-only (choice is required).
 */
import React, { useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useT } from '../lib/i18n';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import type { ImportLocalProfileResult, PeekLocalProfileResult } from '../../../shared/ipc';
import styles from './confirmModal.module.css';

export interface ImportLocalProfileModalProps {
  peek: PeekLocalProfileResult;
  /** The account already has a profile: merge copy + "Not now". */
  existingAccount?: boolean;
  /** Called after the user chooses. `didImport` = the local data was imported. */
  onDone: (didImport: boolean) => void;
}

export type ImportOfferStatus = 'idle' | 'importing' | 'error';

/**
 * Whether an import attempt failed: the call threw (`null`), or some
 * companions could not be brought over.
 */
export function importAttemptFailed(result: ImportLocalProfileResult | null): boolean {
  return result == null || result.failed.length > 0;
}

export function ImportLocalProfileModal({ peek, existingAccount = false, onDone }: ImportLocalProfileModalProps): React.ReactElement {
  const [status, setStatus] = useState<ImportOfferStatus>('idle');
  const [importedAny, setImportedAny] = useState(false);

  async function handleImport(): Promise<void> {
    setStatus('importing');
    let result: ImportLocalProfileResult | null = null;
    try {
      result = await sei.profileImportFromLocal();
    } catch (err) {
      console.warn(`[sei] local import failed: ${(err as Error)?.message ?? String(err)}`);
    }
    const any = importedAny || (result?.imported.length ?? 0) > 0;
    setImportedAny(any);
    if (importAttemptFailed(result)) {
      // Stay up with the error. Whatever did come across is the account's now.
      setStatus('error');
      return;
    }
    onDone(true);
  }

  return (
    <ImportLocalProfileModalView
      peek={peek}
      existingAccount={existingAccount}
      status={status}
      onDecline={() => onDone(false)}
      onImport={() => void handleImport()}
      onContinue={() => onDone(importedAny)}
    />
  );
}

export interface ImportLocalProfileModalViewProps {
  peek: PeekLocalProfileResult;
  existingAccount: boolean;
  status: ImportOfferStatus;
  onDecline: () => void;
  onImport: () => void;
  /** After a failed attempt: leave the modal without retrying. */
  onContinue: () => void;
}

/** The modal's markup for a given status (stateless, so tests can render each one). */
export function ImportLocalProfileModalView({
  peek,
  existingAccount,
  status,
  onDecline,
  onImport,
  onContinue,
}: ImportLocalProfileModalViewProps): React.ReactElement {
  const t = useT();
  const count = peek.migratableCharacterIds.length;

  return (
    <ModalShell title={t('Bring your companion to this account?')} escClose={false}>
      <p className={styles.body}>
        {existingAccount
          ? count > 0
            ? count === 1
              ? t(
                  'You have 1 companion on this computer from before you signed in. Add it and its memories to this account? Nothing already in your account is replaced.',
                )
              : t(
                  'You have {count} companions on this computer from before you signed in. Add them and their memories to this account? Nothing already in your account is replaced.',
                  { count },
                )
            : t(
                'You have companion memories on this computer from before you signed in. Add them to this account? Nothing already in your account is replaced.',
              )
          : count > 0
            ? count === 1
              ? t(
                  'You set up 1 companion before signing in. Bring it, along with your memories together, into this account, or start fresh.',
                )
              : t(
                  'You set up {count} companions before signing in. Bring them, along with your memories together, into this account, or start fresh.',
                  { count },
                )
            : t('Bring your existing setup into this account, or start fresh.')}
      </p>
      {status === 'error' ? (
        <p className={styles.error} role="alert">
          {t('Not everything came over. Try again, or later from Settings.')}
        </p>
      ) : null}
      {status === 'importing' ? (
        <p className={styles.status}>{t('Importing…')}</p>
      ) : status === 'error' ? (
        <ModalFooter>
          <Button kind="ghost" onClick={onContinue}>
            {t('Continue')}
          </Button>
          <Button kind="primary" onClick={onImport}>
            {t('Try again')}
          </Button>
        </ModalFooter>
      ) : (
        <ModalFooter>
          <Button kind="ghost" onClick={onDecline}>
            {existingAccount ? t('Not now') : t('Start fresh')}
          </Button>
          <Button kind="primary" onClick={onImport}>
            {t('Bring it over')}
          </Button>
        </ModalFooter>
      )}
    </ModalShell>
  );
}
