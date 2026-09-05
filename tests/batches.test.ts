import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../lib/db.js';
import { closeBatch, setExpected } from '../app/batches/actions.js';

/**
 * Clôture d'un lot.
 *
 * « Écart non nul = la session ne se ferme pas. » Ce n'est pas une préférence :
 * une double-alimentation de l'ADF fait exister une carte physique sans ligne
 * d'inventaire. On ne la vend pas, on ne la retrouve jamais, et l'écart de
 * comptage est le SEUL signal qu'elle a existé.
 *
 * Ce garde-fou n'était pas testé. Il est de la même famille que l'invariant 2 —
 * si son contournement cessait de laisser une trace, l'écart d'inventaire
 * deviendrait inexplicable six mois plus tard, quand on le remarquerait.
 */
const SESSION = 'test-batches';
let sessionId: string;

async function wipe(): Promise<void> {
  await query(
    `delete from scans where session_id in (select id from sessions where name like $1)`,
    [`${SESSION}%`],
  );
  await query(
    `delete from channel_events
      where event = 'session_closed_with_gap'
        and payload->>'name' like $1`,
    [`${SESSION}%`],
  );
  await query(`delete from sessions where name like $1`, [`${SESSION}%`]);
}

async function ajouterScans(n: number, status = 'resolved'): Promise<void> {
  for (let i = 0; i < n; i++) {
    await query(
      `insert into scans (session_id, seq, front_path, status)
       values ($1, $2, '/x.jpg', $3::scan_status)`,
      [sessionId, i + 1, status],
    );
  }
  await query('update sessions set scanned_count = $2 where id = $1', [sessionId, n]);
}

async function etat(): Promise<{ status: string; closed: string | null }> {
  const { rows } = await query<{ status: string; closed: string | null }>(
    'select status::text, closed_at::text as closed from sessions where id = $1',
    [sessionId],
  );
  return rows[0]!;
}

beforeEach(async () => {
  await wipe();
  const { rows } = await query<{ id: string }>(
    `insert into sessions (name, default_variant, default_condition)
     values ($1,'normal','NM') returning id`,
    [SESSION],
  );
  sessionId = rows[0]!.id;
});

afterAll(async () => {
  await wipe();
  await closePool();
});

describe('closeBatch', () => {
  it('ferme quand le comptage balance', async () => {
    await ajouterScans(12);
    await setExpected(sessionId, 12);

    const res = await closeBatch(sessionId);
    expect(res.ok).toBe(true);
    expect(res.ecart).toBe(0);
    expect((await etat()).status).toBe('closed');
  });

  it('REFUSE quand il manque des cartes — le seul signal d’une carte perdue', async () => {
    // 12 feuilles mises dans l'ADF, 10 scans sortis : deux feuilles sont
    // passées collées. Ces deux cartes existent physiquement et n'ont aucune
    // ligne d'inventaire.
    await ajouterScans(10);
    await setExpected(sessionId, 12);

    const res = await closeBatch(sessionId);
    expect(res.ok).toBe(false);
    expect(res.ecart).toBe(-2);
    expect(res.error).toMatch(/Écart de comptage/);
    // Et le lot reste OUVERT : c'est ce qui force à repasser la pile.
    expect((await etat()).status).toBe('open');
  });

  it('refuse aussi un excédent', async () => {
    // Plus de scans que de feuilles annoncées : le compte est faux dans
    // l'autre sens, et une carte a peut-être été scannée deux fois.
    await ajouterScans(14);
    await setExpected(sessionId, 12);

    const res = await closeBatch(sessionId);
    expect(res.ok).toBe(false);
    expect(res.ecart).toBe(2);
  });

  it('refuse tant que le worker travaille encore', async () => {
    // Fermer pendant le traitement figerait un comptage qui n'est pas final.
    await ajouterScans(5, 'fingerprinted');
    await setExpected(sessionId, 5);

    const res = await closeBatch(sessionId);
    expect(res.ok).toBe(false);
    expect(res.enCours).toBe(5);
    expect(res.error).toMatch(/en traitement/);
  });

  it('des cartes en review n’empêchent PAS la clôture', async () => {
    // Une carte en review est comptée : elle a un scan, elle sera identifiée.
    // Bloquer là-dessus obligerait à vider la review avant de scanner la pile
    // suivante, ce qui n'a aucun rapport avec la réconciliation physique.
    await ajouterScans(8, 'needs_review');
    await setExpected(sessionId, 8);

    expect((await closeBatch(sessionId)).ok).toBe(true);
  });

  it('sans compteur attendu, la réconciliation ne peut rien vérifier', async () => {
    // L'upload ne compte pas de feuilles : `expected_count` reste nul. On ne
    // bloque pas pour autant — mais il faut savoir que le contrôle est inactif.
    await ajouterScans(7);
    const res = await closeBatch(sessionId);
    expect(res.ok).toBe(true);
    expect(res.ecart).toBe(0);
  });

  it('LE CONTOURNEMENT LAISSE UNE TRACE — sinon l’écart est inexplicable', async () => {
    // Il existe des cas légitimes : des pages blanches écartées volontairement.
    // Un garde-fou qu'on ne peut jamais lever se contourne autrement, en pire.
    // Mais il doit rester une trace permanente.
    await ajouterScans(10);
    await setExpected(sessionId, 12);

    const res = await closeBatch(sessionId, true);
    expect(res.ok).toBe(true);
    expect(res.ecart).toBe(-2);
    expect((await etat()).status).toBe('closed');

    const { rows } = await query<{ payload: { ecart: number; expected: number } }>(
      `select payload from channel_events
        where event = 'session_closed_with_gap' and payload->>'session_id' = $1`,
      [sessionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.ecart).toBe(-2);
    expect(rows[0]?.payload.expected).toBe(12);
  });

  it('ne trace rien quand il n’y a pas d’écart', async () => {
    await ajouterScans(12);
    await setExpected(sessionId, 12);
    await closeBatch(sessionId, true);

    const { rows } = await query(
      `select 1 from channel_events
        where event = 'session_closed_with_gap' and payload->>'session_id' = $1`,
      [sessionId],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuse de fermer deux fois', async () => {
    await ajouterScans(3);
    await closeBatch(sessionId);
    const res = await closeBatch(sessionId);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/déjà fermé/);
  });

  it('refuse un lot introuvable', async () => {
    const res = await closeBatch('00000000-0000-0000-0000-000000000000');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/introuvable/);
  });
});

describe('setExpected', () => {
  it('refuse un nombre négatif ou fractionnaire', async () => {
    expect((await setExpected(sessionId, -1)).ok).toBe(false);
    expect((await setExpected(sessionId, 2.5)).ok).toBe(false);
  });

  it('accepte zéro — un lot vide est un comptage valide', async () => {
    expect((await setExpected(sessionId, 0)).ok).toBe(true);
  });

  it('NULL EFFACE le comptage, et ce n’est pas zéro', async () => {
    // Vider le champ voulait dire « je ne sais pas ». Le client envoyait
    // `Number('')`, c'est-à-dire ZÉRO : un lot de 50 cartes affichait alors un
    // écart de +50 et refusait de se fermer, sans retour en arrière possible.
    await ajouterScans(50);
    await setExpected(sessionId, 50);
    expect((await closeBatch(sessionId)).ok).toBe(true);

    await query(`update sessions set status = 'open', closed_at = null where id = $1`, [
      sessionId,
    ]);

    // Zéro : écart de +50, le lot ne se ferme plus.
    await setExpected(sessionId, 0);
    const avecZero = await closeBatch(sessionId);
    expect(avecZero.ok).toBe(false);
    expect(avecZero.ecart).toBe(50);

    // Null : plus de comptage attendu, donc plus rien à vérifier.
    await setExpected(sessionId, null);
    const { rows } = await query<{ e: number | null }>(
      'select expected_count as e from sessions where id = $1',
      [sessionId],
    );
    expect(rows[0]?.e).toBeNull();
    expect((await closeBatch(sessionId)).ok).toBe(true);
  });
});
