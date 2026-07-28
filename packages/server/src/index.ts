/**
 * @anvaya/server — collector and analysis server.
 *
 * Exported so the server can be embedded and, more importantly, driven directly
 * by tests without going through HTTP.
 */

export { createServer, installProcessHandlers } from './server.js';
export type { AnvayaServer, AnvayaServerOptions } from './server.js';

export { loadConfig, redactConfig } from './config/loader.js';
export { configSchema } from './config/schema.js';
export type { Config, DetectionConfig, JudgeConfig, Thresholds } from './config/schema.js';

export { createStorage, SqliteStorage } from './storage/index.js';
export type * from './storage/types.js';

export { createRegistry, BUILTIN_DETECTORS, DetectorRegistry, runSandboxed } from './detectors/index.js';
export type { Detector, DetectionContext, BaselineReader } from './detectors/types.js';
export { evidence, finding } from './detectors/types.js';

export { AnalysisPipeline } from './pipeline/pipeline.js';
export type { AnalysisOutcome, AnalysisPipelineDeps } from './pipeline/pipeline.js';
export { IngestWorker } from './pipeline/worker.js';

export { TraceEnricher } from './analysis/enricher.js';
export { CausalAttributor } from './analysis/attributor.js';
export { BaselineManager } from './analysis/baselines.js';
export { IncidentClusterer } from './analysis/clusterer.js';
export { CohortCorrelator } from './analysis/correlator.js';

export { SpanQueue } from './ingest/queue.js';
export { TraceAssembler } from './ingest/assembler.js';
export { getAdapter, AnvayaAdapter, OtelGenAiAdapter, OpenInferenceAdapter } from './ingest/adapters/index.js';
export { estimateCostUsd, PRICING_VERSION } from './ingest/pricing.js';

export { Metrics } from './telemetry/metrics.js';
export { AlertDispatcher, WebhookChannel } from './alerts/dispatcher.js';
export type { Alert, AlertChannel } from './alerts/dispatcher.js';

export { generateSeedTraces } from './seed/generator.js';
export type { SeedOptions, SeedTrace } from './seed/generator.js';
