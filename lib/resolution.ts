import type { PoolClient } from 'pg';
import { withTransaction } from './db.js';
import { buildSku, type CardCondition, type CardVariant } from './sku.js';

/**
 * Application d'une résolution — LE chemin unique.
 *
 * Le worker (niveau 1 et 2) et l'UI de review (niveau 3) passent tous les deux
 * ici. Deux implémentations de cette fonction divergeraient, et elle touche à la
 * fois les quantités et la bibliothèque d'empreintes : c'est exactement le genre
 * de duplication qui produit un écart d'inventaire silencieux.
 */
export type MatchSource = 'own_history' | 'catalog' | 'llm' | 'manual';

/** Ce qui suffit à dériver un SKU. */
export interface Identity {
  card_id: string;
  variant: CardVariant;
  condition: CardCondition;
  language: string;
}

export interface ResolutionInput {
  scanId: string;
  identity: Identity;
  source: MatchSource;
  confidence: number;
  /** Empreintes du scan, pour nourrir known_fingerprints. */
  phash: string;
  dhash: string;
  embedding: string;
}

/**
 * Tout se fait dans UNE transaction : la ligne d'inventaire, la quantité,
 * l'empreinte et l'état du scan bougent ensemble ou pas du tout.
 *
 * Rejouable : l'appelant doit vérifier que le scan n'est pas déjà résolu avant
 * d'appeler — c'est ce qui empêche une double incrémentation.
 */
export async function applyResolution(input: ResolutionInput): Promise<string> {
  const sku = buildSku(input.identity);

  await withTransaction(async (client) => {
    // La ligne peut ne pas exister : une empreinte connue dont le stock est
    // retombé à zéro reste une empreinte connue (docs/01, décision B).
    await client.query(
      `insert into inventory (sku, card_id, variant, condition, language)
       values ($1, $2, $3, $4, $5)
       on conflict (sku) do nothing`,
      [
        sku,
        input.identity.card_id,
        input.identity.variant,
        input.identity.condition,
        input.identity.language,
      ],
    );

    // Jamais de read-modify-write sur qty_on_hand (invariant 2 de CLAUDE.md).
    await client.query('select apply_qty_delta($1, 1, $2)', [
      sku,
      `scan_${input.source}`,
    ]);

    await writeFingerprint(client, input);

    await client.query(
      `update scans
          set status = 'resolved', match_source = $2, confidence = $3,
              resolved_sku = $4, resolved_at = now()
        where id = $1`,
      [input.scanId, input.source, input.confidence.toFixed(3), sku],
    );
  });

  return sku;
}

/**
 * Toute résolution confirmée nourrit known_fingerprints. C'est le mécanisme qui
 * fait tendre le coût marginal vers zéro — un chemin de résolution qui n'écrit
 * pas ici est un bug (skill card-matching-thresholds §7).
 */
async function writeFingerprint(
  client: PoolClient,
  input: ResolutionInput,
): Promise<void> {
  await client.query(
    `insert into known_fingerprints
       (card_id, variant, condition, language, phash, dhash, embedding,
        source_scan, confirmed_by)
     values ($1,$2,$3,$4,$5::bit(64),$6::bit(64),$7::vector,$8,$9)`,
    [
      input.identity.card_id,
      input.identity.variant,
      input.identity.condition,
      input.identity.language,
      input.phash,
      input.dhash,
      input.embedding,
      input.scanId,
      input.source,
    ],
  );
}
