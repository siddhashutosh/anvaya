/**
 * Composition root.
 *
 * The only file that knows how every component is wired. Also owns process-level
 * error handlers (EH-8) and graceful shutdown (FR-8.6).
 */

import {
  DAY,
  Redactor,
  createLogger,
  type Logger,
} from '@anvaya/core';
import type { FastifyInstance } from 'fastify';
import { AlertDispatcher } from './alerts/dispatcher.js';
import { CausalAttributor } from './analysis/attributor.js';
import { BaselineManager } from './analysis/baselines.js';
import { IncidentClusterer } from './analysis/clusterer.js';
import { CohortCorrelator } from './analysis/correlator.js';
import { TraceEnricher } from './analysis/enricher.js';
import { SessionAnalyzer } from './analysis/session.js';
import { createApp } from './api/app.js';
import { loadConfig, redactConfig } from './config/loader.js';
import type { Config } from './config/schema.js';
import { createJudge } from './detectors/judge/provider.js';
import { createRegistry } from './detectors/index.js';
import type { Detector } from './detectors/types.js';
import { SpanQueue } from './ingest/queue.js';
import { AnalysisPipeline } from './pipeline/pipeline.js';
import { IngestWorker } from './pipeline/worker.js';
import { createStorage } from './storage/index.js';
import type { Storage } from './storage/types.js';
import { Metrics } from './telemetry/metrics.js';

export interface AnvayaServerOptions {
  readonly config?: Config;
  readonly logger?: Logger;
  /** Extra detectors, including user-supplied ones (FR-3.17). */
  readonly detectors?: readonly Detector[];
}

export interface AnvayaServer {
  readonly app: FastifyInstance;
  readonly storage: Storage;
  readonly worker: IngestWorker;
  readonly pipeline: AnalysisPipeline;
  readonly baselines: BaselineManager;
  readonly metrics: Metrics;
  readonly config: Config;
  readonly logger: Logger;
  listen(): Promise<string>;
  shutdown(): Promise<void>;
}

export async function createServer(options: AnvayaServerOptions = {}): Promise<AnvayaServer> {
  const config = options.config ?? loadConfig();

  const logger =
    options.logger ??
    createLogger({
      name: 'anvaya',
      level: config.logging.level,
      format: config.logging.format,
      includeStack: config.logging.includeStack,
      redactor: new Redactor({
        enabled: config.redaction.enabled,
        maxScanLength: config.redaction.maxScanLength,
      }),
    });

  logger.info('starting anvaya', { config: redactConfig(config) });
  if (!config.ingest.apiKey) {
    logger.warn('no ingest API key configured; the ingest endpoint is unauthenticated');
  }

  const redactor = new Redactor({
    enabled: config.redaction.enabled,
    maxScanLength: config.redaction.maxScanLength,
  });

  const metrics = new Metrics();
  const storage = createStorage(config, logger);
  await storage.init();

  const baselines = new BaselineManager(storage, logger);
  await baselines.load();

  const registry = createRegistry(options.detectors ?? []);
  const judge = createJudge(config.judge, logger);

  const pipeline = new AnalysisPipeline({
    registry,
    enricher: new TraceEnricher(),
    attributor: new CausalAttributor(),
    clusterer: new IncidentClusterer({
      windowMs: config.analysis.incidentWindowMs,
      autoResolveMs: config.analysis.autoResolveMs,
      storage,
      logger,
    }),
    correlator: new CohortCorrelator({
      storage,
      cohortKeys: config.analysis.cohortKeys,
      minLift: config.detection.thresholds.cohortLift,
      minSamples: config.detection.thresholds.cohortMinSamples,
      logger,
    }),
    baselines,
    sessionAnalyzer: new SessionAnalyzer({
      thresholds: config.detection.thresholds,
      logger,
    }),
    storage,
    alerts: new AlertDispatcher(config, logger),
    config,
    metrics,
    logger,
    ...(judge ? { judge } : {}),
  });

  const worker = new IngestWorker({
    queue: new SpanQueue({ maxSize: config.ingest.maxQueueSize, logger }),
    pipeline,
    metrics,
    logger,
    traceIdleMs: config.ingest.traceIdleMs,
    maxPendingTraces: config.ingest.maxPendingTraces,
    maxSpansPerTrace: config.ingest.maxSpansPerTrace,
    sweepIntervalMs: config.ingest.sweepIntervalMs,
    concurrency: config.ingest.workerConcurrency,
  });

  const app = await createApp({
    storage,
    worker,
    registry,
    metrics,
    config,
    redactor,
    judgeConfigured: judge !== undefined,
    logger,
  });

  // Periodic maintenance: baseline persistence and retention.
  const maintenanceTimer = setInterval(
    () => {
      void baselines.flush().catch((e) => logger.warn('baseline flush failed', { err: e }));
      if (config.retention.enabled) {
        const cutoff = Date.now() - config.retention.maxAgeDays * DAY;
        void storage
          .purgeOlderThan(cutoff)
          .then((r) => {
            if (r.traces > 0) logger.info('retention purge complete', { ...r, cutoff });
          })
          .catch((e) => logger.warn('retention purge failed', { err: e }));
      }
    },
    Math.min(config.retention.sweepIntervalMs, 60_000),
  );
  if (typeof maintenanceTimer.unref === 'function') maintenanceTimer.unref();

  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down');

    clearInterval(maintenanceTimer);
    // Order matters: stop accepting, drain, flush state, then close storage.
    try {
      await app.close();
    } catch (e) {
      logger.warn('error closing http server', { err: e });
    }
    try {
      await worker.drain();
    } catch (e) {
      logger.warn('error draining worker', { err: e });
    }
    try {
      await baselines.flush();
    } catch (e) {
      logger.warn('error flushing baselines', { err: e });
    }
    await storage.close();
    logger.info('shutdown complete');
  };

  const server: AnvayaServer = {
    app,
    storage,
    worker,
    pipeline,
    baselines,
    metrics,
    config,
    logger,
    async listen() {
      worker.start();
      const address = await app.listen({ host: config.server.host, port: config.server.port });
      logger.info('anvaya listening', {
        address,
        detectors: registry.size,
        judgeConfigured: judge !== undefined,
      });
      return address;
    },
    shutdown,
  };

  return server;
}

/** Process-level handlers (EH-8). Installed only by the CLI, never by tests. */
export function installProcessHandlers(server: AnvayaServer): void {
  const { logger } = server;

  process.on('unhandledRejection', (reason) => {
    logger.fatal('unhandled promise rejection', { err: reason });
  });

  process.on('uncaughtException', (error) => {
    logger.fatal('uncaught exception; exiting', { err: error });
    void server.shutdown().finally(() => process.exit(1));
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      logger.info('signal received', { signal });
      void server.shutdown().finally(() => process.exit(0));
    });
  }
}
