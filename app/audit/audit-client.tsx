'use client';

import { useState } from 'react';
import { reopenScan } from './actions.js';
import type { AuditRow } from './queries.js';

/**
 * Audit visuel des résolutions automatiques.
 *
 * Deux images côte à côte : le scan et la carte que le système a choisie. C'est
 * tout ce dont on a besoin pour trancher, et ça se fait en une seconde par ligne
 * — un tableau de noms demanderait de connaître chaque carte.
 */
export default function AuditClient({ rows }: { rows: AuditRow[] }) {
  const [corrigees, setCorrigees] = useState<Set<string>>(new Set());
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function corriger(scanId: string) {
    setBusy(scanId);
    setErreur(null);
    const res = await reopenScan(scanId);
    setBusy(null);
    if (!res.ok) {
      setErreur(res.error ?? 'échec');
      return;
    }
    setCorrigees((s) => new Set(s).add(scanId));
  }

  if (rows.length === 0) {
    return (
      <div className="page-body">
        <div className="empty" style={{ height: 260 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Rien à vérifier</div>
          <div className="dim">
            Aucune carte résolue automatiquement pour l’instant.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-body">
      {erreur && (
        <div className="note note--alarm" style={{ marginBottom: 'var(--s3)' }}>
          {erreur}
        </div>
      )}

      <div className="note note--warn" style={{ marginBottom: 'var(--s4)' }}>
        Une résolution fausse ne se trompe pas qu’une fois : elle a écrit une
        <strong> empreinte</strong>, et toutes les occurrences suivantes de cette carte
        hériteront de la même erreur. Corriger ici supprime l’empreinte fautive.
      </div>

      <div style={{ display: 'grid', gap: 'var(--s2)' }}>
        {rows.map((r) => {
          const corrigee = corrigees.has(r.scanId);
          return (
            <article
              key={r.scanId}
              className="panel"
              style={{
                display: 'grid',
                gridTemplateColumns: '68px 68px 1fr auto',
                gap: 'var(--s3)',
                alignItems: 'center',
                padding: 'var(--s2) var(--s3)',
                opacity: corrigee ? 0.45 : 1,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/scan/${r.scanId}/image`}
                alt="scan"
                loading="lazy"
                style={{
                  width: 68,
                  height: 94,
                  objectFit: 'cover',
                  objectPosition: 'top',
                  borderRadius: 'var(--r1)',
                  background: 'var(--surface-2)',
                }}
              />
              {r.cardImage ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={r.cardImage}
                  alt={r.cardName}
                  loading="lazy"
                  style={{
                    width: 68,
                    height: 94,
                    objectFit: 'cover',
                    objectPosition: 'top',
                    borderRadius: 'var(--r1)',
                    background: 'var(--surface-2)',
                  }}
                />
              ) : (
                <span
                  style={{
                    width: 68,
                    height: 94,
                    borderRadius: 'var(--r1)',
                    background: 'var(--surface-2)',
                  }}
                />
              )}

              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{r.cardName}</div>
                <div className="dim" style={{ fontSize: 12 }}>
                  {r.setName}{' '}
                  <span className="mono">
                    {r.number}/{r.printedTotal ?? '—'}
                  </span>
                </div>
                <div className="faint mono" style={{ fontSize: 11, marginTop: 2 }}>
                  {r.source === 'catalog' ? 'catalogue' : 'empreinte'}
                  {r.confidence && ` · confiance ${Number(r.confidence).toFixed(2)}`}
                  {r.ocrRead ? ` · OCR ${r.ocrRead}` : ' · OCR rien lu'}
                  {' · '}
                  {r.sessionName} #{r.seq}
                </div>
              </div>

              {corrigee ? (
                <span className="label" style={{ color: 'var(--green)' }}>
                  renvoyée en review
                </span>
              ) : (
                <button
                  className="btn"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                  disabled={busy === r.scanId}
                  onClick={() => void corriger(r.scanId)}
                  title="Décrémente la quantité, supprime l’empreinte, renvoie en review"
                >
                  {busy === r.scanId ? '…' : 'C’est faux'}
                </button>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
