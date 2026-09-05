import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { confirmScan, loadMore, rejectScan, searchCatalog } from '../app/review/actions.js';

/**
 * Les actions de la review.
 *
 * C'est le geste le plus répété du système : sur un lot de 40 cartes, une
 * trentaine passent par là. Chaque confirmation touche l'inventaire ET écrit une
 * empreinte — donc c'est du chemin de l'argent, et une empreinte fausse se
 * propage à toutes les occurrences suivantes de la carte.
 *
 * Ce fichier existe parce que ces deux fonctions n'étaient couvertes
 * qu'indirectement, par les tests de `applyResolution`. Ce qui n'était pas
 * testé, c'est ce que la review ajoute par-dessus : les gardes.
 */
const SESSION = 'test-review-actions';
const CARD = 'base1-4';
const SKU = `${CARD}-normal-NM-en`;

let sessionId: string;
let seq = 0;

const bits = (n: number): string => {
  let s = '';
  for (let i = 0; i < 64; i++) s += ((n >> i % 31) & 1) === 1 ? '1' : '0';
  return s;
};

const vec = (n: number): string => {
  const v = Array.from({ length: 512 }, (_, i) => Math.sin(n * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return `[${v.map((x) => x / norm).join(',')}]`;
};

async function wipe(): Promise<void> {
  await query(`delete from known_fingerprints where card_id = $1`, [CARD]);
  await query(
    `delete from scans where session_id in (select id from sessions where name = $1)`,
    [SESSION],
  );
  await query(`delete from channel_events where sku = $1`, [SKU]);
  await query(`delete from price_history where sku = $1`, [SKU]);
  await query(`delete from inventory where card_id = $1`, [CARD]);
  await query(`delete from sessions where name = $1`, [SESSION]);
}

/** Un scan prêt pour la review : empreint, pas encore résolu. */
async function scanEnAttente(avecEmpreintes = true): Promise<string> {
  seq += 1;
  const { rows } = await query<{ id: string }>(
    avecEmpreintes
      ? `insert into scans (session_id, seq, front_path, phash_front, dhash_front,
                            embedding, status)
         values ($1,$2,'/x.jpg',$3::bit(64),$4::bit(64),$5::vector,'needs_review')
         returning id`
      : `insert into scans (session_id, seq, front_path, status)
         values ($1,$2,'/x.jpg','needs_review') returning id`,
    avecEmpreintes ? [sessionId, seq, bits(seq), bits(seq + 100), vec(seq)] : [sessionId, seq],
  );
  return rows[0]!.id;
}

const identite = {
  cardId: CARD,
  variant: 'normal' as const,
  condition: 'NM' as const,
  language: 'en',
};

beforeEach(async () => {
  await wipe();
  const { rows } = await query<{ id: string }>(
    `insert into sessions (name, default_variant, default_condition)
     values ($1,'normal','NM') returning id`,
    [SESSION],
  );
  sessionId = rows[0]!.id;
  seq = 0;
});

afterAll(async () => {
  await wipe();
  await closePool();
});

async function inventaire(): Promise<{ qty: number; price: string | null } | null> {
  const { rows } = await query<{ qty: number; price: string | null }>(
    'select qty_on_hand as qty, current_price::text as price from inventory where sku = $1',
    [SKU],
  );
  return rows[0] ?? null;
}

describe('confirmScan', () => {
  it('incrémente l’inventaire, écrit l’empreinte, résout le scan', async () => {
    const id = await scanEnAttente();
    const res = await confirmScan({ scanId: id, ...identite, priceCents: null });

    expect(res.ok).toBe(true);
    expect(res.sku).toBe(SKU);
    expect((await inventaire())?.qty).toBe(1);

    const { rows } = await query<{ n: string; src: string }>(
      `select count(*)::text as n, min(confirmed_by::text) as src
         from known_fingerprints where source_scan = $1`,
      [id],
    );
    expect(Number(rows[0]?.n)).toBe(1);
    // `manual` est la seule source de vérité du système : c'est ce qui rend la
    // prochaine occurrence gratuite, par le niveau 1.
    expect(rows[0]?.src).toBe('manual');
  });

  it('REFUSE une seconde confirmation du même scan', async () => {
    // Deux onglets ouverts, ou un double appui sur A. Sans cette garde, la
    // quantité serait incrémentée deux fois pour une seule carte physique.
    const id = await scanEnAttente();
    await confirmScan({ scanId: id, ...identite, priceCents: null });
    const deuxieme = await confirmScan({ scanId: id, ...identite, priceCents: null });

    expect(deuxieme.ok).toBe(false);
    expect(deuxieme.error).toMatch(/déjà résolu/);
    expect((await inventaire())?.qty).toBe(1);
  });

  it('deux exemplaires de la même carte font qty 2 sur UN SKU', async () => {
    // L'invariant 1 : une carte physique n'est pas une ligne d'annonce, elle
    // incrémente un SKU partagé.
    const a = await scanEnAttente();
    const b = await scanEnAttente();
    await confirmScan({ scanId: a, ...identite, priceCents: null });
    await confirmScan({ scanId: b, ...identite, priceCents: null });

    const { rows } = await query<{ n: string }>(
      'select count(*)::text as n from inventory where card_id = $1',
      [CARD],
    );
    expect(Number(rows[0]?.n)).toBe(1);
    expect((await inventaire())?.qty).toBe(2);
  });

  it('un prix saisi va dans l’inventaire ET dans l’historique', async () => {
    // « Pourquoi cette carte est-elle à ce prix ? » doit rester répondable des
    // mois plus tard : le prix courant seul ne le permet pas.
    const id = await scanEnAttente();
    await confirmScan({ scanId: id, ...identite, priceCents: 1250 });

    expect((await inventaire())?.price).toBe('12.50');

    const { rows } = await query<{ price: string; reason: string }>(
      'select price::text, reason from price_history where sku = $1',
      [SKU],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.price).toBe('12.50');
    expect(rows[0]?.reason).toBe('manual');
  });

  it('sans prix, rien n’est écrit dans l’historique', async () => {
    const id = await scanEnAttente();
    await confirmScan({ scanId: id, ...identite, priceCents: null });

    const { rows } = await query('select 1 from price_history where sku = $1', [SKU]);
    expect(rows).toHaveLength(0);
    expect((await inventaire())?.price).toBeNull();
  });

  it('refuse un scan sans empreintes', async () => {
    // Résoudre sans empreinte n'apprendrait rien au niveau 1 : la carte
    // suivante repasserait par la review. Un chemin de résolution qui
    // n'alimente pas known_fingerprints est un bug, pas un raccourci.
    const id = await scanEnAttente(false);
    const res = await confirmScan({ scanId: id, ...identite, priceCents: null });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/empreintes/);
    expect(await inventaire()).toBeNull();
  });

  it('refuse un scan inexistant', async () => {
    const res = await confirmScan({
      scanId: '00000000-0000-0000-0000-000000000000',
      ...identite,
      priceCents: null,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/introuvable/);
  });
});

describe('rejectScan', () => {
  it('écarte sans toucher l’inventaire ni les empreintes', async () => {
    // Un intercalaire, une page blanche : ça arrive dans tout lot réel.
    const id = await scanEnAttente();
    const res = await rejectScan(id, 'page blanche');
    expect(res.ok).toBe(true);

    const { rows } = await query<{ status: string; error: string }>(
      'select status::text, error from scans where id = $1',
      [id],
    );
    expect(rows[0]?.status).toBe('rejected');
    expect(rows[0]?.error).toBe('page blanche');
    expect(await inventaire()).toBeNull();

    const fp = await query('select 1 from known_fingerprints where source_scan = $1', [id]);
    expect(fp.rows).toHaveLength(0);
  });

  it('LA LIGNE RESTE — on ne supprime jamais un scan écarté', async () => {
    // Une page écartée par erreur doit pouvoir être retrouvée. `rejected` est
    // un état terminal, pas une suppression.
    const id = await scanEnAttente();
    await rejectScan(id);
    const { rows } = await query('select 1 from scans where id = $1', [id]);
    expect(rows).toHaveLength(1);
  });

  it('refuse d’écarter un scan déjà résolu', async () => {
    // Sinon l'inventaire garderait une quantité sans scan pour la justifier.
    const id = await scanEnAttente();
    await confirmScan({ scanId: id, ...identite, priceCents: null });

    const res = await rejectScan(id);
    expect(res.ok).toBe(false);
    expect((await inventaire())?.qty).toBe(1);
  });

  it('refuse un scan inexistant', async () => {
    const res = await rejectScan('00000000-0000-0000-0000-000000000000');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/introuvable/);
  });
});

describe('searchCatalog', () => {
  it('trouve par nom', async () => {
    const hits = await searchCatalog('charizard');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => /charizard/i.test(h.name))).toBe(true);
  });

  it('IGNORE LES ACCENTS — on tape au clavier, vite, sans les mettre', async () => {
    const sans = await searchCatalog('flabebe');
    expect(sans.length).toBeGreaterThan(0);
    expect(sans[0]?.name).toMatch(/Flabébé/);
  });

  it('ne cherche pas sur moins de deux caractères', async () => {
    // Une lettre seule ramènerait la moitié du catalogue pour rien, à chaque
    // frappe, pendant qu'on trie.
    expect(await searchCatalog('c')).toEqual([]);
    expect(await searchCatalog('  ')).toEqual([]);
  });

  it('borne le nombre de résultats', async () => {
    const hits = await searchCatalog('ee');
    expect(hits.length).toBeLessThanOrEqual(20);
  });
});

describe('loadMore', () => {
  it('ne renvoie pas ce qui est déjà à l’écran', async () => {
    const a = await scanEnAttente();
    const b = await scanEnAttente();

    const tout = await loadMore([], 200);
    const ids = new Set(tout.map((s) => s.id));
    expect(ids.has(a)).toBe(true);
    expect(ids.has(b)).toBe(true);

    // `exclude` couvre aussi les cartes dont la confirmation est encore en vol :
    // les recharger les ferait réapparaître dans la file après coup.
    const suite = await loadMore([a], 200);
    expect(suite.some((s) => s.id === a)).toBe(false);
    expect(suite.some((s) => s.id === b)).toBe(true);
  });

  it('respecte la limite demandée', async () => {
    await scanEnAttente();
    await scanEnAttente();
    await scanEnAttente();
    expect((await loadMore([], 2)).length).toBeLessThanOrEqual(2);
  });
});
