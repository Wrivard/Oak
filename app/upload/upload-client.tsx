'use client';

import { useCallback, useRef, useState } from 'react';
import type { CardCondition, CardVariant } from '../../lib/sku.js';

/**
 * Upload d'un lot de photos. Voir docs/06-ui.md.
 *
 * Envoi par PAQUETS plutôt qu'en une requête : un lot de 300 photos à 2 Mo fait
 * 600 Mo, ce qu'aucun serveur n'accepte d'un coup et ce qui ne donnerait aucune
 * progression à l'écran. Par paquets, on voit avancer et un échec ne perd que le
 * paquet concerné.
 */
const BATCH = 10;

interface Props {
  variants: readonly CardVariant[];
  conditions: readonly CardCondition[];
  defaultSession: string;
}

interface Rejected {
  name: string;
  reason: string;
}

export default function UploadClient({ variants, conditions, defaultSession }: Props) {
  const [session, setSession] = useState(defaultSession);
  const [variant, setVariant] = useState<CardVariant>('normal');
  const [condition, setCondition] = useState<CardCondition>('NM');
  const [files, setFiles] = useState<File[]>([]);
  const [sent, setSent] = useState(0);
  const [rejected, setRejected] = useState<Rejected[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((incoming: FileList | null) => {
    if (!incoming) return;
    const images = [...incoming].filter((f) => f.type.startsWith('image/'));
    setFiles((prev) => {
      // Dédoublonnage par nom+taille : glisser deux fois le même dossier est
      // une erreur courante, et elle créerait des doublons d'inventaire.
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...images.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
    setDone(false);
  }, []);

  async function upload() {
    if (files.length === 0 || session.trim() === '') return;
    setBusy(true);
    setError(null);
    setSent(0);
    setRejected([]);

    try {
      for (let i = 0; i < files.length; i += BATCH) {
        const form = new FormData();
        form.set('session', session.trim());
        form.set('variant', variant);
        form.set('condition', condition);
        form.set('language', 'en');
        for (const f of files.slice(i, i + BATCH)) form.append('files', f);

        const res = await fetch('/api/upload', { method: 'POST', body: form });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const body = (await res.json()) as { accepted: number; rejected: Rejected[] };
        setSent((n) => n + body.accepted);
        if (body.rejected.length > 0) setRejected((r) => [...r, ...body.rejected]);
      }
      setFiles([]);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const pct = files.length === 0 ? 0 : Math.round((100 * sent) / files.length);

  return (
    <main style={{ padding: 'var(--s5)', maxWidth: 720 }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>Envoyer un lot de photos</h1>
      <p className="dim" style={{ fontSize: 13, marginTop: 'var(--s1)' }}>
        Les photos sont enregistrées puis identifiées par le worker. Rien n&apos;est
        calculé pendant l&apos;envoi : suis l&apos;avancement sur le{' '}
        <a href="/dashboard" style={{ color: 'var(--green)' }}>
          dashboard
        </a>
        .
      </p>

      {/* Le variant est demandé, jamais deviné : le scan à plat écrase le
          reflet du foil, et reverse holo contre normal vaut 5 à 20x d'écart de
          prix. Trier physiquement AVANT de photographier. */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto auto',
          gap: 'var(--s3)',
          marginTop: 'var(--s4)',
        }}
      >
        <label style={{ display: 'grid', gap: 'var(--s1)' }}>
          <span className="label">Nom du lot</span>
          <input value={session} onChange={(e) => setSession(e.target.value)} />
        </label>

        <label style={{ display: 'grid', gap: 'var(--s1)' }}>
          <span className="label">Variant de tout le lot</span>
          <select
            value={variant}
            onChange={(e) => setVariant(e.target.value as CardVariant)}
            style={{ fontWeight: 600 }}
          >
            {variants.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: 'grid', gap: 'var(--s1)' }}>
          <span className="label">Condition</span>
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value as CardCondition)}
          >
            {conditions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </section>

      <p className="faint" style={{ fontSize: 11, marginTop: 'var(--s2)' }}>
        Le variant s&apos;applique à TOUT le lot. Trie les reverse holos à part avant de
        photographier — une photo à plat ne permet pas de les distinguer, et l&apos;écart
        de prix va de 5 à 20 fois.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        style={{
          marginTop: 'var(--s4)',
          padding: 'var(--s6)',
          textAlign: 'center',
          cursor: 'pointer',
          border: `2px dashed ${dragging ? 'var(--green)' : 'var(--border)'}`,
          background: dragging ? 'var(--green-bg)' : 'var(--surface)',
          borderRadius: 'var(--s2)',
          transition: 'border-color 120ms, background 120ms',
        }}
      >
        <div style={{ fontWeight: 600 }}>
          {files.length === 0
            ? 'Glisse tes photos ici'
            : `${files.length} photo${files.length > 1 ? 's' : ''} prête${files.length > 1 ? 's' : ''}`}
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 'var(--s1)' }}>
          ou clique pour choisir · JPEG, PNG, WebP, TIFF · 25 Mo max par photo
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*"
          hidden
          onChange={(e) => addFiles(e.target.files)}
        />
      </div>

      <div style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'center', marginTop: 'var(--s3)' }}>
        <button
          onClick={() => void upload()}
          disabled={busy || files.length === 0 || session.trim() === ''}
          style={{
            padding: 'var(--s2) var(--s4)',
            fontWeight: 600,
            background: files.length > 0 && !busy ? 'var(--green-bg)' : 'var(--surface-2)',
            borderColor: files.length > 0 && !busy ? 'var(--green)' : 'var(--border)',
            color: files.length > 0 && !busy ? 'var(--green)' : 'var(--text-faint)',
          }}
        >
          {busy ? `Envoi… ${pct} %` : 'Envoyer'}
        </button>

        {files.length > 0 && !busy && (
          <button onClick={() => setFiles([])}>Vider</button>
        )}

        {busy && (
          <div
            style={{
              flex: 1,
              height: 6,
              background: 'var(--surface-2)',
              borderRadius: 3,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: '100%',
                background: 'var(--green)',
                transition: 'width 200ms ease-out',
              }}
            />
          </div>
        )}
      </div>

      {done && sent > 0 && (
        <p style={{ color: 'var(--green)', marginTop: 'var(--s3)' }}>
          {sent} photo{sent > 1 ? 's' : ''} envoyée{sent > 1 ? 's' : ''}. Le worker les
          identifie maintenant — les cartes non résolues arriveront dans la{' '}
          <a href="/review" style={{ color: 'var(--green)' }}>
            file de review
          </a>
          .
        </p>
      )}

      {error && <p style={{ color: 'var(--red)', marginTop: 'var(--s3)' }}>{error}</p>}

      {rejected.length > 0 && (
        <section style={{ marginTop: 'var(--s4)' }}>
          <div className="label">
            {rejected.length} refusée{rejected.length > 1 ? 's' : ''}
          </div>
          {/* Jamais en silence : un fichier refusé sans explication devient une
              carte physique qui n'a pas de ligne. */}
          <ul className="mono faint" style={{ fontSize: 12, margin: 'var(--s1) 0 0', paddingLeft: 'var(--s4)' }}>
            {rejected.slice(0, 20).map((r, i) => (
              <li key={i}>
                {r.name} — {r.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
