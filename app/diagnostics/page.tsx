import { query } from '../../lib/db.js';
import AutoRefresh from '../dashboard/auto-refresh.js';

/**
 * Diagnostic du matching — l'expérience 1bis de PROMPTS.md, en continu.
 *
 * L'expérience demandait 100 scans étiquetés à la main pour mesurer le taux de
 * lecture du numéro par ère. Depuis la migration 007, chaque scan enregistre ce
 * que l'OCR a lu : la mesure se fait donc sur TOUT ce qui passe, en permanence,
 * sur de vrais scans plutôt que sur un échantillon.
 *
 * Décision de l'expérience, reprise ici : sous 85 % global, le niveau 2 change
 * de design. Ventilation sous 60 % sur une ère, crop era-aware obligatoire.
 *
 * LE TAUX DE LECTURE SE MESURE SUR LES SCANS QUI ONT ATTEINT L'OCR.
 *
 * Un scan résolu au niveau 1 — empreinte déjà connue — n'exécute jamais l'OCR :
 * `recordOcr` n'est appelé qu'après la tentative de niveau 2. Le compter au
 * dénominateur ferait BAISSER le taux de lecture à mesure que la base
 * d'empreintes grandit, c'est-à-dire à mesure que le système marche mieux. On
 * lirait « le niveau 2 s'effondre, il faut le redessiner » exactement quand le
 * niveau 1 fait son travail.
 *
 * Sans colonne dédiée, deux cas sautent l'OCR et se reconnaissent :
 * `match_source = 'own_history'`, et le conflit de variant détecté au niveau 1,
 * qui part en review avant même d'essayer le catalogue.
 */
export const dynamic = 'force-dynamic';

const SEUIL_GLOBAL = 85;
const SEUIL_ERE = 60;

/** Les scans qui ont réellement exécuté l'OCR. Voir le commentaire de tête. */
const A_TENTE_OCR = `
  s.match_source is distinct from 'own_history'
  and coalesce(s.variant_conflict, false) = false`;

interface EraRow {
  ere: string;
  total: string;
  /** Dénominateur du taux de lecture : ceux qui ont atteint l'OCR. */
  mesures: string;
  lus: string;
  resolus: string;
}

interface BandRow {
  ocr_band: number | null;
  n: string;
}

/**
 * Les ères de PROMPTS.md étape 1bis, découpées par date de sortie du set.
 * Le découpage est approximatif et assumé : ce qui compte est de voir si une
 * tranche décroche, pas de trancher un débat de collectionneurs.
 */
const ERES = `
  case
    when c.set_release >= date '2022-01-01' then '4 · moderne (SV)'
    when c.set_release >= date '2019-01-01' then '3 · SWSH'
    when c.set_release >= date '2011-01-01' then '2 · BW / XY / SM'
    when c.set_release is not null          then '1 · vintage'
    else '5 · date inconnue'
  end`;

export default async function DiagnosticsPage() {
  const [{ rows: eras }, { rows: bands }, { rows: global }] = await Promise.all([
    query<EraRow>(
      `select ${ERES} as ere,
              count(*)::text as total,
              count(*) filter (where ${A_TENTE_OCR})::text as mesures,
              count(*) filter (where s.ocr_read is not null)::text as lus,
              count(*) filter (where s.status = 'resolved')::text as resolus
         from scans s
         left join inventory i on i.sku = s.resolved_sku
         left join cards c on c.id = i.card_id
        where s.status in ('resolved', 'needs_review')
        group by 1 order by 1`,
    ),
    query<BandRow>(
      `select ocr_band, count(*)::text as n
         from scans where ocr_read is not null
        group by 1 order by 1`,
    ),
    query<{ total: string; mesures: string; lus: string; resolus: string }>(
      `select count(*)::text as total,
              count(*) filter (where ${A_TENTE_OCR})::text as mesures,
              count(*) filter (where s.ocr_read is not null)::text as lus,
              count(*) filter (where s.status = 'resolved')::text as resolus
         from scans s where s.status in ('resolved', 'needs_review')`,
    ),
  ]);

  const total = Number(global[0]?.total ?? 0);
  const mesures = Number(global[0]?.mesures ?? 0);
  const lus = Number(global[0]?.lus ?? 0);
  const resolus = Number(global[0]?.resolus ?? 0);
  /**
   * Traités au niveau 1 : résolus par empreinte, ou renvoyés en review pour
   * conflit de variant. Les deux sortent avant que l'OCR ne s'exécute.
   */
  const niveau1 = total - mesures;
  const tauxOcr = mesures === 0 ? 0 : (100 * lus) / mesures;
  const tauxAuto = total === 0 ? 0 : (100 * resolus) / total;

  return (
    <>
      <AutoRefresh seconds={20} />
      <header className="page-head">
        <h1 className="page-title">Diagnostic du matching</h1>
        <span className="page-sub">{total.toLocaleString('fr')} scans mesurés</span>
      </header>

      <div className="page-body">
        <div className="narrow">
          {total === 0 ? (
            <div className="empty" style={{ height: 240 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Rien à mesurer</div>
              <div className="dim">
                Envoie un lot : chaque scan enregistre ce que l’OCR a lu, et cette page
                devient l’expérience 1bis en continu.
              </div>
            </div>
          ) : (
            <>
              <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s3)' }}>
                <article className="panel">
                  <div className="label">Numéro lu par l’OCR</div>
                  <div
                    className="num"
                    style={{
                      fontSize: 30,
                      color: tauxOcr >= SEUIL_GLOBAL ? 'var(--green)' : 'var(--amber)',
                    }}
                  >
                    {tauxOcr.toFixed(1)} %
                  </div>
                  <div className="faint" style={{ fontSize: 11 }}>
                    {lus} sur {mesures} · décision à {SEUIL_GLOBAL} %
                    {niveau1 > 0 && (
                      <>
                        <br />
                        {niveau1} traité{niveau1 > 1 ? 's' : ''} au niveau 1, sans
                        passer par l’OCR — hors dénominateur
                      </>
                    )}
                  </div>
                </article>

                <article className="panel">
                  <div className="label">Résolu sans intervention</div>
                  <div className="num" style={{ fontSize: 30 }}>
                    {tauxAuto.toFixed(1)} %
                  </div>
                  <div className="faint" style={{ fontSize: 11 }}>
                    {resolus} sur {total}
                  </div>
                </article>
              </section>

              {tauxOcr < SEUIL_GLOBAL && (
                <div className="note note--warn" style={{ marginTop: 'var(--s3)' }}>
                  Sous {SEUIL_GLOBAL} % de lecture, la décision de l’expérience 1bis est
                  que <strong>le niveau 2 change de design</strong> avant d’aller plus
                  loin. Regarde la ventilation par ère : si une seule tranche décroche,
                  c’est un problème de crop, pas de conception.
                </div>
              )}

              <section className="panel" style={{ marginTop: 'var(--s3)' }}>
                <div className="panel-head">
                  <span className="label">Par ère</span>
                  <span className="faint" style={{ fontSize: 11 }}>
                    sous {SEUIL_ERE} % sur une ère : crop era-aware obligatoire
                  </span>
                </div>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Ère</th>
                      <th>Scans</th>
                      <th>Numéro lu</th>
                      <th>Résolus</th>
                    </tr>
                  </thead>
                  <tbody>
                    {eras.map((e) => {
                      // Même dénominateur que le taux global : ceux qui ont
                      // atteint l'OCR, pas tous les scans de l'ère.
                      const m = Number(e.mesures);
                      const pct = m === 0 ? 0 : (100 * Number(e.lus)) / m;
                      return (
                        <tr key={e.ere}>
                          <td>{e.ere}</td>
                          <td className="mono">
                            {e.total}
                            {Number(e.total) !== m && (
                              <span className="faint"> · {m} mesurés</span>
                            )}
                          </td>
                          <td
                            className="num"
                            style={{
                              color:
                                pct >= SEUIL_GLOBAL
                                  ? 'var(--green)'
                                  : pct >= SEUIL_ERE
                                    ? 'var(--amber)'
                                    : 'var(--red)',
                            }}
                          >
                            {pct.toFixed(0)} %
                          </td>
                          <td className="mono dim">{e.resolus}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="faint" style={{ fontSize: 11, marginTop: 'var(--s2)' }}>
                  L’ère est déduite de la date de sortie du set, donc connue seulement
                  pour les cartes résolues. Les non résolues comptent dans « date
                  inconnue » — c’est justement là que se cache le problème.
                </p>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <span className="label">Bande de crop qui a réussi</span>
                </div>
                {/* Si le vintage ne sort que de la bande 1 et le moderne de la
                    bande 0, la question du crop era-aware est tranchée sans
                    avoir à deviner. */}
                <table className="table">
                  <thead>
                    <tr>
                      <th>Bande</th>
                      <th>Lectures</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bands.map((b) => (
                      <tr key={String(b.ocr_band)}>
                        <td className="mono">
                          {b.ocr_band === null ? '—' : `bande ${b.ocr_band}`}
                          <span className="faint">
                            {b.ocr_band === 0 && ' · bas-gauche (moderne)'}
                            {b.ocr_band === 1 && ' · bas-droite (vintage)'}
                            {b.ocr_band === 2 && ' · pleine largeur'}
                            {b.ocr_band === 3 && ' · bande haute'}
                          </span>
                        </td>
                        <td className="num">{b.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
