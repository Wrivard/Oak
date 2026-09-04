/**
 * Calcule l'embedding CLIP de l'image officielle de chaque carte.
 *
 *   pnpm seed:embeddings
 *
 * Reprenable : ne traite que les cartes absentes de card_embeddings pour le
 * modèle courant. Une coupure ne coûte que le lot en cours.
 *
 * Sur les images mortes. 20 000 images chez deux hébergeurs tiers : il y en aura
 * toujours d'indisponibles. Un 404 est définitif et la carte est écartée pour ce
 * run ; une erreur réseau ou un 5xx est transitoire et retentée. Sans cette
 * distinction, la requête de reprise resélectionne les mêmes cartes mortes à
 * chaque lot et le script tourne en rond.
 */
import { closePool, query } from '../lib/db.js';
import { EMBED_MODEL, embed, toVectorLiteral } from '../lib/fingerprint/embed.js';
import { log } from '../lib/log.js';

const BATCH = 100;
const FETCH_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_TRANSIENT_RETRIES = 3;

interface Card {
  id: string;
  image_small: string;
}

type FetchResult =
  | { kind: 'ok'; card: Card; buf: Buffer }
  | { kind: 'permanent'; card: Card; reason: string }
  | { kind: 'transient'; card: Card; reason: string };

async function fetchImage(card: Card): Promise<FetchResult> {
  try {
    const res = await fetch(card.image_small, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404 || res.status === 410) {
      return { kind: 'permanent', card, reason: `HTTP ${res.status}` };
    }
    if (!res.ok) return { kind: 'transient', card, reason: `HTTP ${res.status}` };
    return { kind: 'ok', card, buf: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    // Timeout, DNS, connexion coupée : transitoire par défaut.
    return { kind: 'transient', card, reason: String(err) };
  }
}

/** Le réseau est le facteur limitant, pas le CPU : on télécharge par vagues. */
async function fetchAll(cards: readonly Card[]): Promise<FetchResult[]> {
  const out: FetchResult[] = [];
  for (let i = 0; i < cards.length; i += FETCH_CONCURRENCY) {
    out.push(
      ...(await Promise.all(cards.slice(i, i + FETCH_CONCURRENCY).map(fetchImage))),
    );
  }
  return out;
}

async function main(): Promise<void> {
  const started = Date.now();

  // Cartes écartées pour ce run. En mémoire volontairement : un 404 aujourd'hui
  // peut être réparé demain, donc un nouveau run les retente une fois.
  const givenUp = new Set<string>();
  const transientCount = new Map<string, number>();

  const { rows: pending } = await query<{ n: string }>(
    `select count(*)::text as n from cards c
      where c.image_small is not null
        and not exists (
          select 1 from card_embeddings e
           where e.card_id = c.id and e.model = $1
        )`,
    [EMBED_MODEL],
  );
  const total = Number(pending[0]?.n ?? 0);
  log.info('seed embeddings — début', { model: EMBED_MODEL, a_traiter: total });

  let done = 0;

  for (;;) {
    const { rows: batch } = await query<Card>(
      `select c.id, c.image_small from cards c
        where c.image_small is not null
          and not (c.id = any($3::text[]))
          and not exists (
            select 1 from card_embeddings e
             where e.card_id = c.id and e.model = $1
          )
        order by c.id
        limit $2`,
      [EMBED_MODEL, BATCH, [...givenUp]],
    );
    if (batch.length === 0) break;

    const results = await fetchAll(batch);

    const values: string[] = [];
    const params: unknown[] = [];

    for (const r of results) {
      if (r.kind === 'permanent') {
        givenUp.add(r.card.id);
        log.warn('image absente définitivement, carte écartée', {
          card_id: r.card.id,
          reason: r.reason,
        });
        continue;
      }
      if (r.kind === 'transient') {
        const n = (transientCount.get(r.card.id) ?? 0) + 1;
        transientCount.set(r.card.id, n);
        if (n >= MAX_TRANSIENT_RETRIES) {
          givenUp.add(r.card.id);
          log.warn('échec réseau répété, carte écartée', {
            card_id: r.card.id,
            tentatives: n,
            reason: r.reason,
          });
        }
        continue;
      }

      try {
        const v = await embed(r.buf);
        params.push(r.card.id, toVectorLiteral(v), EMBED_MODEL);
        values.push(
          `($${params.length - 2}, $${params.length - 1}::vector, $${params.length})`,
        );
      } catch (err) {
        givenUp.add(r.card.id);
        log.warn('embedding échoué, carte écartée', { card_id: r.card.id, err });
      }
    }

    if (values.length > 0) {
      await query(
        `insert into card_embeddings (card_id, embedding, model)
         values ${values.join(',')}
         on conflict (card_id) do update
            set embedding  = excluded.embedding,
                model      = excluded.model,
                created_at = now()`,
        params,
      );
      done += values.length;

      const elapsed = (Date.now() - started) / 1000;
      log.info('progression', {
        done,
        ecartees: givenUp.size,
        total,
        pct: total > 0 ? Math.round((100 * (done + givenUp.size)) / total) : 100,
        cartes_par_sec: Math.round((done / elapsed) * 10) / 10,
      });
    }
  }

  const { rows: cov } = await query<{ n: string }>(
    'select count(*)::text as n from card_embeddings where model = $1',
    [EMBED_MODEL],
  );

  log.info('seed embeddings — fin', {
    done,
    ecartees: givenUp.size,
    embeddings_en_base: Number(cov[0]?.n ?? 0),
    duration_ms: Date.now() - started,
  });

  // Écarter quelques images mortes est normal. Ne rien avoir embeddé du tout ne
  // l'est pas — c'est le seul cas qui mérite un exit non nul.
  if (Number(cov[0]?.n ?? 0) === 0) {
    log.error('aucun embedding en base');
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    log.error('seed embeddings échoué', { err });
    process.exitCode = 1;
  })
  .finally(() => closePool());
