import { log } from '../../lib/log.js';
import { claim, complete, fail, reclaimStale, type Job } from './queue.js';

export type Handler = (job: Job) => Promise<void>;

export interface TypeConfig {
  handler: Handler;
  /** Jobs de ce type traités simultanément. */
  concurrency: number;
}

const IDLE_POLL_MS = 500;
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
        lanes.push(this.lane(type, cfg.handler));
      }
    }
    await Promise.all(lanes);

    clearInterval(this.reaper);
    log.info('worker arrêté', { worker_id: this.workerId });
  }

  /** Une voie = un slot de concurrence sur un type. */
  private async lane(type: string, handler: Handler): Promise<void> {
    while (!this.stopping) {
      let job: Job | null;
      try {
        job = await claim(type, this.workerId);
      } catch (err) {
        // Base injoignable : on ne veut ni boucler à vide ni mourir.
        log.error('réclamation impossible', { job_type: type, err });
        await sleep(IDLE_POLL_MS * 4);
        continue;
      }

      if (!job) {
        await sleep(IDLE_POLL_MS);
        continue;
      }

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
