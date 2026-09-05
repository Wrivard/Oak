import { afterEach, describe, expect, it } from 'vitest';
import {
  breakerSnapshot,
  CircuitOpen,
  FAILURE_THRESHOLD,
  isOpen,
  OPEN_MS,
  recordFailure,
  recordSuccess,
  resetBreakers,
  withBreaker,
} from '../worker/queue/breaker.js';

/**
 * Circuit breaker. Voir docs/05-production.md §2.4.
 *
 * Ce qu'il empêche : qu'une panne eBay de vingt minutes brûle max_attempts sur
 * des milliers de jobs et laisse une montagne de `dead` à rejouer à la main.
 */
afterEach(() => resetBreakers());

describe('circuit breaker', () => {
  it('reste fermé sous le seuil', () => {
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) recordFailure('ebay');
    expect(isOpen('ebay')).toBe(false);
  });

  it('s’ouvre au seuil d’échecs consécutifs', () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) recordFailure('ebay');
    expect(isOpen('ebay')).toBe(true);
  });

  it('un succès remet le compteur à zéro', () => {
    // « Consécutifs » est le mot qui compte : neuf échecs puis un succès puis
    // neuf échecs ne doivent PAS ouvrir le circuit.
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) recordFailure('ebay');
    recordSuccess('ebay');
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) recordFailure('ebay');
    expect(isOpen('ebay')).toBe(false);
  });

  it('se referme après la fenêtre d’ouverture', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < FAILURE_THRESHOLD; i++) recordFailure('ebay', t0);
    expect(isOpen('ebay', t0)).toBe(true);
    expect(isOpen('ebay', t0 + OPEN_MS + 1)).toBe(false);
  });

  it('les services sont indépendants', () => {
    // Une panne pokemontcg ne doit pas couper eBay.
    for (let i = 0; i < FAILURE_THRESHOLD; i++) recordFailure('pokemontcg');
    expect(isOpen('pokemontcg')).toBe(true);
    expect(isOpen('ebay')).toBe(false);
  });

  it('withBreaker lève CircuitOpen quand le circuit est ouvert', async () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) recordFailure('ebay');
    await expect(withBreaker('ebay', async () => 'jamais')).rejects.toBeInstanceOf(
      CircuitOpen,
    );
  });

  it('withBreaker laisse passer et enregistre le succès', async () => {
    recordFailure('ebay');
    await expect(withBreaker('ebay', async () => 'ok')).resolves.toBe('ok');
    expect(breakerSnapshot().find((s) => s.service === 'ebay')?.failures).toBe(0);
  });

  it('shouldTrip permet de ne PAS compter certaines erreurs', async () => {
    // Un refus de whitelisting n'est pas une panne : le compter ouvrirait le
    // circuit et couperait aussi les appels qui, eux, fonctionnent.
    class NotEntitled extends Error {}
    for (let i = 0; i < FAILURE_THRESHOLD + 5; i++) {
      await withBreaker(
        'ebay',
        () => Promise.reject(new NotEntitled()),
        (e) => !(e instanceof NotEntitled),
      ).catch(() => undefined);
    }
    expect(isOpen('ebay')).toBe(false);
  });

  it('CircuitOpen porte la date de reprise, pour replanifier le job', () => {
    const err = new CircuitOpen('ebay', 42);
    expect(err.retryAt).toBe(42);
    expect(err.service).toBe('ebay');
  });
});
