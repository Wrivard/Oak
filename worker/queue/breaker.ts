import { log } from '../../lib/log.js';

/**
 * Circuit breaker par service externe. Voir docs/05-production.md §2.4.
 *
 * Après N échecs consécutifs, le circuit s'ouvre : les jobs qui dépendent de ce
 * service sont repoussés SANS consommer de tentative.
 *
 * Sans ça, une panne eBay de 20 minutes brûle `max_attempts` sur des milliers de
 * jobs et laisse une montagne de `dead` à rejouer à la main — c'est-à-dire que la
 * panne de vingt minutes devient une soirée de travail.
 */
export const FAILURE_THRESHOLD = 10;
export const OPEN_MS = 5 * 60 * 1000;

export type Service = 'pokemontcg' | 'ebay' | 'tcgplayer';

interface State {
  consecutiveFailures: number;
  openUntil: number | null;
}

const states = new Map<Service, State>();

function stateOf(service: Service): State {
  let s = states.get(service);
  if (!s) {
    s = { consecutiveFailures: 0, openUntil: null };
    states.set(service, s);
  }
  return s;
}

/** Levée quand un job touche un service dont le circuit est ouvert. */
export class CircuitOpen extends Error {
  override readonly name = 'CircuitOpen';
  readonly service: Service;
  /** Epoch ms auquel le circuit se referme. Le job est replanifié à cette date. */
  readonly retryAt: number;

  constructor(service: Service, retryAt: number) {
    super(
      `circuit ouvert sur ${service} jusqu'à ${new Date(retryAt).toISOString()}`,
    );
    this.service = service;
    this.retryAt = retryAt;
  }
}

export function isOpen(service: Service, now = Date.now()): boolean {
  const s = stateOf(service);
  if (s.openUntil === null) return false;
  if (now >= s.openUntil) {
    // Demi-ouverture : on laisse UN essai passer. S'il échoue, le compteur est
    // déjà au seuil et le circuit se rouvre immédiatement.
    s.openUntil = null;
    log.info('circuit refermé, essai de reprise', { service });
    return false;
  }
  return true;
}

export function recordSuccess(service: Service): void {
  const s = stateOf(service);
  if (s.consecutiveFailures > 0) {
    log.info('service rétabli', { service, apres_echecs: s.consecutiveFailures });
  }
  s.consecutiveFailures = 0;
  s.openUntil = null;
}

export function recordFailure(service: Service, now = Date.now()): void {
  const s = stateOf(service);
  s.consecutiveFailures += 1;

  if (s.consecutiveFailures >= FAILURE_THRESHOLD && s.openUntil === null) {
    s.openUntil = now + OPEN_MS;
    log.error('circuit OUVERT', {
      service,
      echecs_consecutifs: s.consecutiveFailures,
      reouverture: new Date(s.openUntil).toISOString(),
    });
  }
}

/**
 * Exécute un appel externe sous protection du circuit.
 *
 * `shouldTrip` distingue ce qui compte comme panne du service de ce qui n'en est
 * pas une : un 404 est une réponse valide, pas une indisponibilité, et le
 * compter ouvrirait le circuit sur des cartes simplement absentes du catalogue.
 */
export async function withBreaker<T>(
  service: Service,
  fn: () => Promise<T>,
  shouldTrip: (err: unknown) => boolean = () => true,
): Promise<T> {
  const s = stateOf(service);
  if (isOpen(service)) {
    throw new CircuitOpen(service, s.openUntil ?? Date.now() + OPEN_MS);
  }

  try {
    const result = await fn();
    recordSuccess(service);
    return result;
  } catch (err) {
    if (shouldTrip(err)) recordFailure(service);
    throw err;
  }
}

/** Réservé aux tests. */
export function resetBreakers(): void {
  states.clear();
}

/** Pour le dashboard : l'état de chaque circuit. */
export function breakerSnapshot(): { service: Service; open: boolean; failures: number }[] {
  return [...states.entries()].map(([service, s]) => ({
    service,
    open: s.openUntil !== null && Date.now() < s.openUntil,
    failures: s.consecutiveFailures,
  }));
}
