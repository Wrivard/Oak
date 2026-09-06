import { log } from '../../lib/log.js';
import { ATTENTE_MIN_MS, prochaineAttente } from './attente.js';
import { CircuitOpen } from './breaker.js';
import { claim, complete, defer, fail, reclaimStale, type Job } from './queue.js';

export type Handler = (job: Job) => Promise<void>;

export interface TypeConfig {
  handler: Handler;
  /** Jobs de ce type traités simultanément. */
  concurrency: number;
  /**
   * Attente maximale entre deux réclamations vides, en millisecondes.
   *
   * C'est le délai qu'un job de ce type peut passer dans la file avant qu'une
   * voie ne le voie, quand rien ne tournait avant lui. Court pour ce qu'un
   * humain attend, long pour le travail de fond. Voir `attente.ts`.
   */
  idleMaxMs?: number;
}

/** Défaut : le chemin qu'on regarde. Deux secondes au pire. */
const IDLE_MAX_DEFAUT_MS = 2000;
const REAP_EVERY_MS = 60_000;

/**
 * Boucle de worker. Un handler par type, concurrence configurable par type.
 *
 * Arrêt propre : sur SIGTERM/SIGINT, on cesse de réclamer de nouveaux jobs et on
 * laisse finir ceux en cours. Un job interrompu brutalement resterait en
 * `running` jusqu'à expiration de son bail — correct mais lent.
 */
export class Worker {
  private stopping = false;
  private readonly running = new Set<Promise<void>>();
  private reaper: NodeJS.Timeout | undefined;

  constructor(
    private readonly workerId: string,
    private readonly types: Readonly<Record<string, TypeConfig>>,
  ) {}

  async run(): Promise<void> {
    log.info('worker démarré', {
      worker_id: this.workerId,
      types: Object.keys(this.types),
    });

    // Reprise des jobs abandonnés par un worker mort, au démarrage puis en continu.
    await reclaimStale();
    this.reaper = setInterval(() => {
      void reclaimStale().catch((err: unknown) =>
        log.error('reaper en échec', { err }),
      );
    }, REAP_EVERY_MS);

    const lanes: Promise<void>[] = [];
    for (const [type, cfg] of Object.entries(this.types)) {
      for (let i = 0; i < cfg.concurrency; i++) {
        lanes.push(this.lane(type, cfg.handler, cfg.idleMaxMs ?? IDLE_MAX_DEFAUT_MS));
      }
    }
    await Promise.all(lanes);

    clearInterval(this.reaper);
    log.info('worker arrêté', { worker_id: this.workerId });
  }

  /** Une voie = un slot de concurrence sur un type. */
  private async lane(type: string, handler: Handler, idleMaxMs: number): Promise<void> {
    // Chaque voie garde SON attente : deux voies du même type n'ont pas de
    // raison de se réveiller ensemble, et les décaler étale les requêtes.
    let attente = ATTENTE_MIN_MS;

    while (!this.stopping) {
      let job: Job | null;
      try {
        job = await claim(type, this.workerId);
      } catch (err) {
        // Base injoignable : on ne veut ni boucler à vide ni mourir.
        log.error('réclamation impossible', { job_type: type, err });
        await sleep(Math.max(attente, ATTENTE_MIN_MS) * 4);
        continue;
      }

      if (!job) {
        await sleep(attente);
        attente = prochaineAttente(attente, idleMaxMs);
        continue;
      }

      // Du travail : on redevient réactif. Un lot arrive rarement seul, et la
      // carte suivante ne doit pas attendre le plafond.
      attente = ATTENTE_MIN_MS;

      const started = Date.now();
      const task = this.execute(job, handler, started);
      this.running.add(task);
      try {
        await task;
      } finally {
        this.running.delete(task);
      }
    }
  }

  private async execute(job: Job, handler: Handler, started: number): Promise<void> {
    try {
      await handler(job);
      await complete(job);
      log.info('job terminé', {
        job_id: job.id,
        job_type: job.type,
        attempts: job.attempts,
        duration_ms: Date.now() - started,
      });
    } catch (err) {
      // Circuit ouvert : le service externe est en panne, pas le job. On le
      // repousse à la réouverture sans lui compter de tentative.
      if (err instanceof CircuitOpen) {
        await defer(job, err.retryAt, err.message).catch((e: unknown) =>
          log.error('impossible de repousser le job', { job_id: job.id, err: e }),
        );
        return;
      }
      // Jamais de catch vide : toute erreur avalée est loggée avec son contexte.
      await fail(job, err).catch((e: unknown) =>
        log.error('impossible de marquer le job en échec', { job_id: job.id, err: e }),
      );
    }
  }

  /** Cesse de réclamer, laisse finir l'en-cours. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    log.info('arrêt demandé, on laisse finir les jobs en cours', {
      en_cours: this.running.size,
    });
    await Promise.allSettled([...this.running]);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
