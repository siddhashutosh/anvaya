/**
 * Configuration schema (FR-8.1, FR-8.2).
 *
 * Every detector threshold lives here so tuning never requires a code change
 * (FR-8.3). Defaults are deliberately conservative: false-positive fatigue is the
 * highest-likelihood risk in the design (Design Doc §11).
 */

import { z } from 'zod';

export const serverConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(4319),
  /** Enables stack traces in error responses. Must stay false in production (NFR-4.6). */
  devMode: z.boolean().default(false),
  corsOrigins: z.array(z.string()).default(['http://localhost:5173', 'http://127.0.0.1:5173']),
  bodyLimitBytes: z.number().int().positive().default(8 * 1024 * 1024),
  shutdownTimeoutMs: z.number().int().positive().default(10_000),
});

export const storageConfigSchema = z.object({
  driver: z.literal('sqlite').default('sqlite'),
  path: z.string().default('./data/anvaya.db'),
  busyTimeoutMs: z.number().int().positive().default(5000),
});

export const ingestConfigSchema = z.object({
  apiKey: z.string().optional(),
  maxQueueSize: z.number().int().positive().default(20_000),
  workerConcurrency: z.number().int().min(1).max(16).default(2),
  /** A trace is analysed when its root closes, or after this idle period. */
  traceIdleMs: z.number().int().positive().default(5000),
  maxPendingTraces: z.number().int().positive().default(2000),
  /** Per-trace span ceiling; excess is dropped and counted (see TraceAssembler). */
  maxSpansPerTrace: z.number().int().positive().default(10_000),
  sweepIntervalMs: z.number().int().positive().default(1000),
  redactServerSide: z.boolean().default(true),
});

export const detectionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Per-detector kill switch, keyed by detector id (FR-3.4). */
  disabledDetectors: z.array(z.string()).default([]),
  tiers: z
    .object({
      L0: z.boolean().default(true),
      L1: z.boolean().default(true),
      L2: z.boolean().default(true),
      /** Off by default — costs money (ADR-0003, FR-3.13). */
      L3: z.boolean().default(false),
    })
    .default({}),
  detectorBudgetMs: z.number().int().positive().default(2000),
  /** A cheaper tier asserting at or above this suppresses L3 for the same code. */
  shortCircuitConfidence: z.number().min(0).max(1).default(0.8),
  minBaselineSamples: z.number().int().positive().default(30),

  thresholds: z
    .object({
      // L0
      contextUtilisationWarn: z.number().min(0).max(1).default(0.9),
      stepRepetitionCount: z.number().int().min(2).default(3),
      stepRepetitionSimilarity: z.number().min(0).max(1).default(0.9),
      retryStormAttempts: z.number().int().min(2).default(3),
      excessiveToolCalls: z.number().int().positive().default(25),
      tokenBudgetPerTrace: z.number().int().positive().default(150_000),
      // L1
      groundednessSupport: z.number().min(0).max(1).default(0.15),
      groundednessUnsupportedRatio: z.number().min(0).max(1).default(0.3),
      repetitionRatio: z.number().min(0).max(1).default(0.35),
      duplicateRetrievalRatio: z.number().min(0).max(1).default(0.4),
      indexStalenessDays: z.number().positive().default(180),
      systemPromptLeakChars: z.number().int().positive().default(60),
      cacheHitRatioFloor: z.number().min(0).max(1).default(0.2),
      minCachedPromptTokens: z.number().int().positive().default(4000),
      // session-scoped (ADR-0008)
      /** Messages that must vanish between turns before CTX-003 fires. */
      sessionHistoryLossMessages: z.number().int().min(1).default(2),
      /** Messages a conversation must have had before a restart counts as CTX-004. */
      sessionResetMinPriorMessages: z.number().int().min(2).default(3),
      // L2
      zScore: z.number().positive().default(3),
      retrievalScoreZ: z.number().positive().default(3),
      psiModerate: z.number().positive().default(0.1),
      psiSignificant: z.number().positive().default(0.25),
      jsDivergence: z.number().min(0).max(1).default(0.1),
      burstRateRatio: z.number().positive().default(3),
      cohortLift: z.number().positive().default(2),
      cohortMinSamples: z.number().int().positive().default(20),
      scoreEntropyFloor: z.number().min(0).max(1).default(0.95),
    })
    .default({}),
});

export const judgeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['anthropic', 'none']).default('none'),
  apiKey: z.string().optional(),
  model: z.string().default('claude-haiku-4-5-20251001'),
  /**
   * Messages API base URL. Configurable so the judge can be pointed at a gateway,
   * an egress proxy, or a local fake — hardcoding it made this tier untestable
   * without spending real money, which is why it had no coverage.
   */
  baseUrl: z.string().url().default('https://api.anthropic.com'),
  /** Fraction of eligible traces that reach the judge tier. */
  sampleRate: z.number().min(0).max(1).default(0.1),
  maxTokensPerTrace: z.number().int().positive().default(4000),
  dailyTokenBudget: z.number().int().positive().default(500_000),
  timeoutMs: z.number().int().positive().default(20_000),
  enabledDetectors: z.array(z.string()).default([]),
});

export const analysisConfigSchema = z.object({
  incidentWindowMs: z.number().int().positive().default(6 * 60 * 60 * 1000),
  autoResolveMs: z.number().int().positive().default(24 * 60 * 60 * 1000),
  cohortKeys: z.array(z.string()).default(['service', 'environment', 'model', 'route']),
});

export const alertsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  minSeverity: z.enum(['critical', 'high', 'medium', 'low', 'info']).default('high'),
  webhookUrl: z.string().url().optional(),
  timeoutMs: z.number().int().positive().default(5000),
});

export const loggingConfigSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  format: z.enum(['json', 'pretty']).default('pretty'),
  includeStack: z.boolean().default(true),
});

export const redactionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxScanLength: z.number().int().positive().default(200_000),
});

export const retentionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxAgeDays: z.number().int().positive().default(30),
  sweepIntervalMs: z.number().int().positive().default(6 * 60 * 60 * 1000),
});

export const configSchema = z.object({
  server: serverConfigSchema.default({}),
  storage: storageConfigSchema.default({}),
  ingest: ingestConfigSchema.default({}),
  detection: detectionConfigSchema.default({}),
  judge: judgeConfigSchema.default({}),
  analysis: analysisConfigSchema.default({}),
  alerts: alertsConfigSchema.default({}),
  logging: loggingConfigSchema.default({}),
  redaction: redactionConfigSchema.default({}),
  retention: retentionConfigSchema.default({}),
});

export type Config = z.output<typeof configSchema>;
export type DetectionConfig = Config['detection'];
export type Thresholds = DetectionConfig['thresholds'];
export type JudgeConfig = Config['judge'];
