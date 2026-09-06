'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CardCondition, CardVariant } from '../../lib/sku.js';
import { estImage, filesFromDrop, type DropSource } from '../../lib/upload/drop.js';
import { nomDeLotInvalide } from '../../lib/upload/nom-de-lot.js';
import { enPaquets } from '../../lib/upload/paquets.js';

/**
 * Envoi d'un lot de photos. Voir docs/06-ui.md.
 *
 * Envoi par PAQUETS : un lot de 300 photos à 2 Mo fait 600 Mo, ce qu'aucun
 * serveur n'accepte d'un coup et ce qui ne donnerait aucune progression à
 * l'écran. Par paquets, on voit avancer et un échec ne perd que le paquet.
 *
 * Le découpage est borné en OCTETS autant qu'en nombre de fichiers : voir
 * lib/upload/paquets.ts. Dix TIFF de 20 Mo faisaient une requête de 200 Mo.
 */

/** Un lot récent, réduit à ce qui se lit d'un coup d'oeil. */
export interface LotRecent {
  id: string;
  name: string;
  openedAt: string;
  status: string;
  resolved: number;
  review: number;
  pending: number;
  rejected: number;
}

interface Props {
  variants: readonly CardVariant[];
  conditions: readonly CardCondition[];
  defaultSession: string;
  derniers: LotRecent[];
  /** Rendu côté serveur : un `Link` ne traverse pas la frontière client. */
  lienLots: ReactNode;
}

interface Rejected {
  name: string;
  reason: string;
}

interface Existant {
  pages: number;
  scans: number;
  status: 'open' | 'closed' | null;
}

export default function UploadClient({
  variants,
  conditions,
  defaultSession,
  derniers,
  lienLots,
}: Props) {
  const [session, setSession] = useState(defaultSession);
  const [variant, setVariant] = useState<CardVariant>('normal');
  const [condition, setCondition] = useState<CardCondition>('NM');
  const [duplex, setDuplex] = useState(true);
  /** Nombre de cartes réellement mises dans le scanner. Texte : le champ peut être vide. */
  const [attendues, setAttendues] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sent, setSent] = useState(0);
  const [rejected, setRejected] = useState<Rejected[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [lecture, setLecture] = useState(false);
  /** Ce que le lot visé contient DÉJÀ, côté serveur. */
  const [existant, setExistant] = useState<Existant | null>(null);
  /** Pages réellement arrivées quand un envoi casse en route. */
  const [atterries, setAtterries] = useState<number | null>(null);
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

  /**
   * Ce que le lot visé contient déjà.
   *
   * Envoyer deux fois le même dossier n'écrase plus rien — mais ça AJOUTE, et
   * l'inventaire compte alors chaque carte deux fois. La réconciliation finit
   * par l'attraper à la clôture ; le voir AVANT de lancer 2000 pages coûte
   * beaucoup moins cher.
   *
   * Débouncé : le nom se tape lettre par lettre, et chaque lettre est une
   * requête si on ne l'attend pas.
   */
  useEffect(() => {
    const nom = session.trim();
    if (nom === '') {
      setExistant(null);
      return;
    }
    let vivant = true;
    const t = setTimeout(() => {
      void fetch(`/api/upload?session=${encodeURIComponent(nom)}`)
        .then((r) => (r.ok ? (r.json() as Promise<Existant>) : null))
        .then((e) => {
          if (vivant) setExistant(e);
        })
        .catch(() => {
          // Pas de réponse : on n'affiche rien plutôt qu'une fausse assurance.
          if (vivant) setExistant(null);
        });
    }, 350);
    return () => {
      vivant = false;
      clearTimeout(t);
    };
  }, [session, done]);

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
    if (files.length === 0 || nomInvalide !== null) return;
    setBusy(true);
    setError(null);
    setSent(0);
    setRejected([]);
    setAtterries(null);
    let arrivees = existant?.pages ?? 0;

    try {
      // L'ORDRE EST L'INFORMATION : c'est lui qui porte l'alternance
      // recto/verso. On trie par nom et on transmet le rang.
      const ordered = [...files].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      );

      for (const paquet of enPaquets(ordered)) {
        const form = new FormData();
        form.set('session', session.trim());
        form.set('variant', variant);
        form.set('condition', condition);
        form.set('language', 'en');
        for (const f of paquet) form.append('files', f);

        const res = await fetch('/api/upload', { method: 'POST', body: form });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const body = (await res.json()) as {
          accepted: number;
          rejected: Rejected[];
          total: number;
        };
        arrivees = body.total;
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
          expected: attenduesNombre,
        }),
      });
      if (!fin.ok) {
        const body = (await fin.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `finalisation : HTTP ${fin.status}`);
      }

      setDone(ordered.length);
      setFiles([]);
      setAttendues('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Le chiffre qui compte quand un envoi casse : combien de pages sont
      // réellement arrivées. Sans lui, on renvoie le dossier entier « au cas
      // où » et l'inventaire compte tout en double.
      setAtterries(arrivees);
    } finally {
      setBusy(false);
    }
  }

  // Le même contrôle que la route, pour ne pas envoyer 2000 pages avant de se
  // faire refuser. Le client n'est pas la sécurité : la route refuse aussi.
  const nomInvalide = nomDeLotInvalide(session.trim());

  const attenduesNombre =
    attendues.trim() === '' || !/^\d+$/.test(attendues.trim())
      ? null
      : Number(attendues.trim());

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
            disabled={busy || files.length === 0 || nomInvalide !== null}
          >
            {busy ? `Envoi ${pct} %` : 'Envoyer le lot'}
          </button>
        </div>
      </header>

      <div className="page-body">
        <div className="colonne-envoi">
          {/*
            UN SEUL OBJET, pas trois panneaux empilés de poids égal.

            L'écran présentait les réglages, le recto-verso et la zone de dépôt
            comme trois cartes identiques : rien ne disait par où commencer, et
            l'action — déposer un dossier — se retrouvait la plus basse et la
            plus vide des trois. Ici les réglages sont une barre d'outils, et le
            corps de la carte EST la zone de dépôt.
          */}
          <section className="panel panel--flush">
            <div className="reglages">
              <label className="field" style={{ flex: '1 1 170px' }}>
                <span className="label">Nom du lot</span>
                <input
                  className={`input${nomInvalide !== null && session.trim() !== '' ? ' input--erreur' : ''}`}
                  value={session}
                  onChange={(e) => setSession(e.target.value)}
                />
              </label>

              {/* Le variant est l'erreur la plus coûteuse du système : 5 à 20x
                  d'écart de prix. Il est demandé, jamais deviné — et il vire à
                  l'ambre dès qu'il quitte « normal », pour qu'un lot de reverse
                  holo ne parte pas sans qu'on l'ait vu. */}
              <label className="field" style={{ flex: '0 0 168px' }}
                     title="S'applique à TOUT le lot. Une photo à plat ne distingue pas un reverse holo d'un normal : trie-les à part.">
                <span className="label">Variant</span>
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

              <label className="field" style={{ flex: '0 0 84px' }}>
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

              {/* Le seul contrôle qui rattrape une double-alimentation de l'ADF.
                  Sans lui, une carte physiquement scannée sans ligne
                  d'inventaire ne se signale JAMAIS. */}
              <label className="field" style={{ flex: '0 0 110px' }}
                     title="Le nombre de cartes réellement mises dans le scanner. Sans lui, la réconciliation ne vérifie rien.">
                <span className="label">Comptées</span>
                <input
                  className="input mono"
                  inputMode="numeric"
                  placeholder="—"
                  value={attendues}
                  onChange={(e) => setAttendues(e.target.value.replace(/[^0-9]/g, ''))}
                />
              </label>
            </div>

            <label className="bascule" title="L'appariement se fait par la position. L'empreinte des dos vérifie ensuite l'alternance : si une page manque, le lot est signalé au lieu de décaler toutes les cartes suivantes.">
              <input
                type="checkbox"
                className="check"
                checked={duplex}
                onChange={(e) => setDuplex(e.target.checked)}
              />
              <span>
                <strong>Recto-verso</strong>
                <span className="faint"> — image0001 recto, image0002 verso</span>
              </span>
            </label>

            {/* LA ZONE DE DÉPÔT, dans la même carte et sur toute sa largeur.
                C'est l'action de l'écran : elle en occupe le corps. */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                // Les types DOM scindent FileSystemEntry en sous-types fichier
                // et dossier ; l'objet réel porte bien `file` ou `createReader`
                // selon ce que disent `isFile` / `isDirectory`. Le cast dit ça.
                void onDrop(e.dataTransfer as unknown as DropSource);
              }}
              onClick={() => dirRef.current?.click()}
              className={`depot${dragging ? ' depot--survol' : ''}${files.length > 0 ? ' depot--pret' : ''}`}
            >
              <span className="depot-icone" aria-hidden>
                {files.length > 0 ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M4 12.5l5 5L20 6.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" strokeLinecap="round" />
                  </svg>
                )}
              </span>

              <span className="depot-titre">
                {lecture
                  ? 'Lecture du dossier…'
                  : files.length === 0
                    ? 'Glisse le dossier du scanner'
                    : `${files.length} photo${files.length > 1 ? 's' : ''} prête${files.length > 1 ? 's' : ''}`}
              </span>

              <span className="depot-sous">
                {files.length === 0
                  ? 'ou choisis-le ci-dessous · JPEG, PNG, WebP, TIFF · 25 Mo par photo'
                  : `~${cartes} carte${cartes > 1 ? 's' : ''} ${duplex ? 'en recto-verso' : 'en recto seul'} · prêtes à envoyer`}
              </span>

              <span className="depot-actions">
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
              </span>

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
          </section>

          {/* Les explications SOUS la carte, en une ligne chacune. Elles étaient
              deux paragraphes au milieu du formulaire : on ne lit pas un mode
              d'emploi entre deux champs, on le saute — et il pousse l'action
              hors de l'écran. Le détail vit dans les infobulles des champs. */}
          {nomInvalide !== null && session.trim() !== '' ? (
            <p className="hint" style={{ color: 'var(--red)', marginTop: 'var(--s3)' }}>
              {nomInvalide}
            </p>
          ) : (
            <p className="hint" style={{ marginTop: 'var(--s3)' }}>
              {attenduesNombre === null ? (
                <>
                  Renseigne <strong>Comptées</strong> pour que la réconciliation puisse
                  vérifier le lot : deux feuilles passées collées font une carte sans
                  ligne d’inventaire, et l’écart de comptage est le seul signal.
                </>
              ) : (
                <>
                  Le lot ne se fermera que si <strong>{attenduesNombre}</strong> carte
                  {attenduesNombre > 1 ? 's' : ''} en sortent
                  {cartes > 0 && attenduesNombre !== cartes
                    ? ` — les photos sélectionnées en annoncent ${cartes}`
                    : ''}
                  .
                </>
              )}
            </p>
          )}

          {/*
            LES DERNIERS LOTS. Après avoir envoyé, la question suivante est
            toujours « et alors, qu'est-ce qu'elles deviennent ». Les avoir ici
            évite un aller-retour vers /batches à chaque envoi — et l'écran
            cesse d'être une carte seule au milieu du vide.
          */}
          {derniers.length > 0 && (
            <section className="recents">
              <div className="recents-tete">
                <span className="label">Derniers lots</span>
                {lienLots}
              </div>
              {derniers.map((b) => {
                const total = b.resolved + b.review + b.pending + b.rejected;
                const part = (n: number): string =>
                  total === 0 ? '0%' : `${(100 * n) / total}%`;
                return (
                  <div key={b.id} className="recent">
                    <span className="recent-nom">{b.name}</span>
                    <span className="recent-date mono">{b.openedAt}</span>
                    {/* La barre porte l'information, pas un pourcentage : ce
                        qui compte n'est pas « combien c'est avancé » mais
                        « combien va coûter du temps humain ». */}
                    <span className="recent-barre" title={`${b.resolved} résolues · ${b.review} en review · ${b.pending} en cours`}>
                      <i style={{ width: part(b.resolved), background: 'var(--green)' }} />
                      <i style={{ width: part(b.review), background: 'var(--amber)' }} />
                      <i style={{ width: part(b.rejected), background: 'var(--text-faint)' }} />
                      <i style={{ width: part(b.pending), background: 'var(--border-strong)' }} />
                    </span>
                    <span className="recent-compte mono">
                      {total === 0 ? '—' : `${total} carte${total > 1 ? 's' : ''}`}
                    </span>
                    <span className={`recent-etat${b.status === 'open' ? '' : ' recent-etat--clos'}`}>
                      {b.status === 'open' ? 'ouvert' : 'fermé'}
                    </span>
                  </div>
                );
              })}
            </section>
          )}

          {existant !== null && existant.pages > 0 && (
            <div
              className={`note note--${existant.status === 'closed' ? 'alarm' : 'warn'}`}
              style={{ marginTop: 'var(--s3)' }}
            >
              {existant.status === 'closed' ? (
                <>
                  <strong>Ce lot est fermé.</strong> Il contient {existant.pages} page
                  {existant.pages > 1 ? 's' : ''} et {existant.scans} carte
                  {existant.scans > 1 ? 's' : ''}. Y ajouter des photos rouvrirait un
                  comptage déjà réconcilié — prends plutôt un nouveau nom.
                </>
              ) : (
                <>
                  <strong>
                    Ce lot contient déjà {existant.pages} page
                    {existant.pages > 1 ? 's' : ''}
                  </strong>{' '}
                  ({existant.scans} carte{existant.scans > 1 ? 's' : ''} créée
                  {existant.scans > 1 ? 's' : ''}). Les nouvelles s&apos;ajouteront à la
                  suite. Renvoyer le même dossier compterait chaque carte deux fois.
                </>
              )}
            </div>
          )}

          {atterries !== null && (
            <div className="note note--warn" style={{ marginTop: 'var(--s3)' }}>
              <strong>{atterries} page{atterries > 1 ? 's' : ''} sont arrivées</strong>{' '}
              avant l&apos;échec. Ne renvoie pas le dossier entier : retire les{' '}
              {atterries} premières photos, ou change de nom de lot et réconcilie à la
              main.
            </div>
          )}

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
