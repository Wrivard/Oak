'use client';

import { useState } from 'react';
import { closeBatch, repairBatch, setExpected } from './actions.js';
import type { Batch } from './queries.js';

/**
 * Actions d'un lot : renseigner le comptage attendu, puis fermer.
 *
 * La réconciliation n'est possible que si `expected_count` est renseigné.
 * L'upload ne connaît pas de compteur de feuilles, contrairement à un ADF : il
 * faut donc saisir le nombre de cartes réellement mises dans le scanner, sinon
 * le contrôle ne vérifie rien.
 */
export default function BatchActions({ batch }: { batch: Batch }) {
  const [expected, setExpectedValue] = useState(
    batch.expected === null ? '' : String(batch.expected),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmGap, setConfirmGap] = useState(false);
  const [outils, setOutils] = useState(false);

  if (batch.status !== 'open') {
    return (
      <span className="faint" style={{ fontSize: 11 }}>
        fermé {batch.closedAt}
      </span>
    );
  }

  async function saveExpected() {
    // Champ vidé = « je ne sais pas », pas « zéro ». `Number('')` vaut zéro, et
    // un lot de 50 cartes affichait alors un écart de +50 sans qu'on puisse
    // revenir en arrière.
    const brut = expected.trim();
    const n = brut === '' ? null : Number(brut);
    if (n !== null && !Number.isInteger(n)) return;
    if (n === batch.expected) return;

    setBusy(true);
    const res = await setExpected(batch.id, n);
    setBusy(false);
    setError(res.ok ? null : (res.error ?? 'échec'));
  }

  /**
   * Relance l'appariement.
   *
   * L'appariement est enfilé par le PUT de fin d'envoi. Si ce PUT échoue, les
   * pages sont sur le disque et aucun job n'existe : le lot reste à zéro carte
   * pour toujours, sans erreur. Rejouer est sans danger — `pair_upload` ignore
   * les fichiers déjà rattachés à un scan.
   */
  async function reapparier(mode: 'duplex' | 'front_only') {
    setBusy(true);
    setError(null);
    const res = await repairBatch(batch.id, mode);
    setBusy(false);
    setError(
      res.ok
        ? res.enfile
          ? null
          : 'un appariement identique est déjà en file'
        : (res.error ?? 'échec'),
    );
    if (res.ok && res.enfile) setOutils(false);
  }

  async function close(force: boolean) {
    setBusy(true);
    setError(null);
    const res = await closeBatch(batch.id, force);
    setBusy(false);
    if (res.ok) {
      setConfirmGap(false);
      return;
    }
    setError(res.error ?? 'échec');
    // Un écart n'est pas un refus définitif : il ouvre une confirmation
    // explicite, tracée en base si elle est donnée.
    if (res.ecart !== undefined && res.ecart !== 0) setConfirmGap(true);
  }

  return (
    <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          className="input mono"
          style={{ width: 68, height: 26, textAlign: 'right' }}
          placeholder="attendu"
          value={expected}
          onChange={(e) => setExpectedValue(e.target.value.replace(/\D/g, ''))}
          onBlur={() => void saveExpected()}
          title="Nombre de cartes réellement mises dans le scanner"
        />
        <button
          className="btn"
          style={{ height: 26 }}
          disabled={busy}
          onClick={() => void close(false)}
        >
          Fermer
        </button>
      </div>

      {error && (
        <span style={{ color: 'var(--red)', fontSize: 11, maxWidth: 260, textAlign: 'right' }}>
          {error}
        </span>
      )}

      {confirmGap && (
        <button
          className="btn"
          style={{ height: 24, borderColor: 'var(--red)', color: 'var(--red)' }}
          disabled={busy}
          onClick={() => void close(true)}
        >
          Fermer quand même — l’écart sera tracé
        </button>
      )}

      {/* Replié : c'est une réparation, pas une étape du flux normal. On ne
          l'ouvre que lorsqu'un lot est resté à zéro carte. */}
      <button
        className="btn btn--ghost"
        style={{ height: 22, fontSize: 11 }}
        onClick={() => setOutils((v) => !v)}
      >
        {outils ? 'Masquer' : 'Réparer'}
      </button>

      {outils && (
        <div style={{ display: 'grid', gap: 4, justifyItems: 'end' }}>
          <span className="faint" style={{ fontSize: 11, maxWidth: 260, textAlign: 'right' }}>
            Des pages sur le disque mais aucune carte ? La finalisation de
            l’envoi a échoué. Relancer l’appariement est sans danger : les pages
            déjà traitées sont ignorées.
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn"
              style={{ height: 24 }}
              disabled={busy}
              onClick={() => void reapparier('duplex')}
            >
              Apparier recto-verso
            </button>
            <button
              className="btn"
              style={{ height: 24 }}
              disabled={busy}
              onClick={() => void reapparier('front_only')}
            >
              Recto seul
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
