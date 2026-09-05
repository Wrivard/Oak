'use client';

import { useCallback, useRef, useState } from 'react';
import type { CardCondition, CardVariant } from '../../lib/sku.js';
import { estImage, filesFromDrop, type DropSource } from '../../lib/upload/drop.js';

/**
 * Envoi d'un lot de photos. Voir docs/06-ui.md.
 *
 * Envoi par PAQUETS : un lot de 300 photos à 2 Mo fait 600 Mo, ce qu'aucun
 * serveur n'accepte d'un coup et ce qui ne donnerait aucune progression à
 * l'écran. Par paquets, on voit avancer et un échec ne perd que le paquet.
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
  const [duplex, setDuplex] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [sent, setSent] = useState(0);
  const [rejected, setRejected] = useState<Rejected[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [lecture, setLecture] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement | null>(null);

  const addFiles = useCallback((incoming: readonly File[] | FileList | null) => {
    if (!incoming) return;
    const images = [...incoming].filter(estImage);
    setFiles((prev) => {
      // Dédoublonnage par nom + taille : glisser deux fois le même dossier est
      // une erreur courante, et elle créerait des doublons d'inventaire.
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...images.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
    setDone(0);
  }, []);

  const onDrop = useCallback(
    async (dt: DropSource) => {
      // Descendre dans un dossier de 2000 pages prend plusieurs secondes. Sans
      // ce témoin, l'écran reste figé sur « Glisse tes photos ici » et on
      // reglisse par-dessus, ce qui doublerait le lot si le dédoublonnage ne
      // rattrapait pas le coup.
      setLecture(true);
      try {
        addFiles(await filesFromDrop(dt));
      } finally {
        setLecture(false);
      }
    },
    [addFiles],
  );

  async function upload() {
    if (files.length === 0 || session.trim() === '') return;
    setBusy(true);
    setError(null);
    setSent(0);
    setRejected([]);

    try {
      // L'ORDRE EST L'INFORMATION : c'est lui qui porte l'alternance
      // recto/verso. On trie par nom et on transmet le rang.
      const ordered = [...files].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      );

      for (let i = 0; i < ordered.length; i += BATCH) {
        const form = new FormData();
        form.set('session', session.trim());
        form.set('variant', variant);
        form.set('condition', condition);
        form.set('language', 'en');
        form.set('offset', String(i));
        for (const f of ordered.slice(i, i + BATCH)) form.append('files', f);

        const res = await fetch('/api/upload', { method: 'POST', body: form });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const body = (await res.json()) as { accepted: number; rejected: Rejected[] };
        setSent((n) => n + body.accepted);
        if (body.rejected.length > 0) setRejected((r) => [...r, ...body.rejected]);
      }

      // Le lot est complet : c'est seulement maintenant qu'on peut apparier,
      // parce qu'il faut voir TOUTES les pages pour vérifier l'alternance.
      const fin = await fetch('/api/upload', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: session.trim(),
          mode: duplex ? 'duplex' : 'front_only',
        }),
      });
      if (!fin.ok) {
        const body = (await fin.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `finalisation : HTTP ${fin.status}`);
      }

      setDone(ordered.length);
      setFiles([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const pct = files.length === 0 ? 0 : Math.round((100 * sent) / files.length);
  const cartes = duplex ? Math.ceil(files.length / 2) : files.length;

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">Envoyer des photos</h1>
        <span className="page-sub">
          {files.length > 0
            ? `${files.length} page${files.length > 1 ? 's' : ''} · ~${cartes} carte${cartes > 1 ? 's' : ''}`
            : 'aucune photo sélectionnée'}
        </span>
        <div className="page-actions">
          {files.length > 0 && !busy && (
            <button className="btn btn--ghost" onClick={() => setFiles([])}>
              Vider
            </button>
          )}
          <button
            className="btn btn--primary"
            onClick={() => void upload()}
            disabled={busy || files.length === 0 || session.trim() === ''}
          >
            {busy ? `Envoi ${pct} %` : 'Envoyer le lot'}
          </button>
        </div>
      </header>

      <div className="page-body">
        <div className="narrow">
          <section className="panel">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 190px 110px',
                gap: 'var(--s3)',
              }}
            >
              <label className="field">
                <span className="label">Nom du lot</span>
                <input
                  className="input"
                  value={session}
                  onChange={(e) => setSession(e.target.value)}
                />
              </label>

              {/* Le variant est l'erreur la plus coûteuse du système : 5 à 20x
                  d'écart de prix. Il est demandé, jamais deviné. */}
              <label className="field">
                <span className="label">Variant du lot</span>
                <select
                  className={`select${variant !== 'normal' ? ' select--warn' : ''}`}
                  value={variant}
                  onChange={(e) => setVariant(e.target.value as CardVariant)}
                >
                  {variants.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span className="label">Condition</span>
                <select
                  className="select"
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
            </div>

            <p className="faint" style={{ fontSize: 12, margin: 'var(--s3) 0 0' }}>
              Le variant s&apos;applique à <strong>tout le lot</strong>. Une photo à plat
              ne permet pas de distinguer un reverse holo d&apos;un normal — trie-les à
              part et fais-en un lot séparé.
            </p>
          </section>

          <section className="panel">
            <label
              style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'flex-start', cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={duplex}
                onChange={(e) => setDuplex(e.target.checked)}
                style={{ marginTop: 3, accentColor: 'var(--green)' }}
              />
              <span>
                <strong>Recto-verso</strong>
                <span className="dim"> — image0001 recto, image0002 verso, etc.</span>
                <br />
                <span className="faint" style={{ fontSize: 12 }}>
                  L&apos;appariement se fait par la position. L&apos;empreinte des dos
                  vérifie ensuite l&apos;alternance : si une page manque, le lot est
                  signalé au lieu de décaler toutes les cartes suivantes.
                </span>
              </span>
            </label>
          </section>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              // Les types DOM scindent FileSystemEntry en sous-types fichier et
              // dossier ; l'objet réel porte bien `file` ou `createReader` selon
              // ce que disent `isFile` / `isDirectory`. Le cast dit ça.
              void onDrop(e.dataTransfer as unknown as DropSource);
            }}
            onClick={() => inputRef.current?.click()}
            className="panel"
            style={{
              marginTop: 'var(--s3)',
              padding: 'var(--s6)',
              textAlign: 'center',
              cursor: 'pointer',
              borderStyle: 'dashed',
              borderColor: dragging ? 'var(--green)' : 'var(--border)',
              background: dragging ? 'var(--green-bg)' : 'var(--surface)',
              transition: 'border-color 120ms ease, background 120ms ease',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 15 }}>
              {lecture
                ? 'Lecture du dossier…'
                : files.length === 0
                  ? 'Glisse le dossier du scanner ici'
                  : `${files.length} photo${files.length > 1 ? 's' : ''} prête${files.length > 1 ? 's' : ''}`}
            </div>
            <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
              dossier ou fichiers · JPEG, PNG, WebP, TIFF · 25 Mo par photo
            </div>

            <div
              style={{
                display: 'flex',
                gap: 'var(--s2)',
                justifyContent: 'center',
                marginTop: 'var(--s3)',
              }}
            >
              <button
                className="btn"
                onClick={(e) => {
                  e.stopPropagation();
                  dirRef.current?.click();
                }}
              >
                Choisir un dossier
              </button>
              <button
                className="btn btn--ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  inputRef.current?.click();
                }}
              >
                Choisir des fichiers
              </button>
            </div>

            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/*"
              hidden
              onChange={(e) => addFiles(e.target.files)}
            />
            {/* `webkitdirectory` n'est pas dans les types React : il est posé
                par ref. C'est ce qui fait que « Choisir un dossier » ouvre un
                sélecteur de DOSSIER et non de fichiers. */}
            <input
              ref={(el) => {
                dirRef.current = el;
                if (el) el.setAttribute('webkitdirectory', '');
              }}
              type="file"
              multiple
              hidden
              onChange={(e) => addFiles(e.target.files)}
            />
          </div>

          {busy && (
            <div className="bar" style={{ marginTop: 'var(--s3)' }}>
              <i style={{ width: `${pct}%` }} />
            </div>
          )}

          {done > 0 && (
            <div className="note note--ok" style={{ marginTop: 'var(--s3)' }}>
              {done} page{done > 1 ? 's' : ''} envoyée{done > 1 ? 's' : ''}
              {duplex && ` — environ ${Math.ceil(done / 2)} cartes`}. Le worker apparie et
              identifie ; les cartes non résolues arriveront dans la review.
            </div>
          )}

          {error && (
            <div className="note note--alarm" style={{ marginTop: 'var(--s3)' }}>
              {error}
            </div>
          )}

          {rejected.length > 0 && (
            <section className="panel" style={{ marginTop: 'var(--s3)' }}>
              <div className="panel-head">
                <span className="label">
                  {rejected.length} refusée{rejected.length > 1 ? 's' : ''}
                </span>
              </div>
              {/* Jamais en silence : un fichier refusé sans explication devient
                  une carte physique sans ligne d'inventaire. */}
              <ul className="mono faint" style={{ fontSize: 12, margin: 0, paddingLeft: 'var(--s4)' }}>
                {rejected.slice(0, 20).map((r, i) => (
                  <li key={i}>
                    {r.name} — {r.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
