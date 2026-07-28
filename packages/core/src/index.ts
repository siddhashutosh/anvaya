/**
 * @anvaya/core — the shared domain vocabulary.
 *
 * Depended on by @anvaya/sdk, @anvaya/server and (for types) @anvaya/ui.
 * Imports nothing internal: this is the base of the dependency graph (NFR-5.2).
 */

// types
export type {
  AttributeMap,
  AttributeValue,
  ConfidenceBand,
  DetectorTier,
  Page,
  Severity,
  TimeRange,
} from './types/common.js';
export {
  CONFIDENCE_BANDS,
  SEVERITY_RANK,
  TIER_ORDER,
  confidenceBand,
  maxSeverity,
} from './types/common.js';

export type {
  AgentPayload,
  ChatMessage,
  LlmPayload,
  RetrievalPayload,
  RetrievedDocument,
  SpanEvent,
  SpanKind,
  SpanRecord,
  SpanStatus,
  ToolCallRef,
  ToolPayload,
} from './types/span.js';
export { SPAN_KINDS } from './types/span.js';

export type {
  NormalizedTrace,
  SpanNode,
  TraceMetrics,
  TraceRecord,
  TraceSummary,
} from './types/trace.js';

export type { SessionSummary, SessionTurn, SessionWindow } from './types/session.js';

export type {
  Attribution,
  AttributionLink,
  BaselineRow,
  BaselineStats,
  CohortHypothesis,
  Evidence,
  Finding,
  FindingRole,
  Incident,
  IncidentStatus,
} from './types/finding.js';

// taxonomy
export type {
  FailureMode,
  FailureSource,
  TaxonomyCode,
  TaxonomyFamily,
} from './taxonomy/types.js';
export { FAMILY_LABELS, TAXONOMY_FAMILIES } from './taxonomy/types.js';
export {
  CATALOG,
  TAXONOMY_VERSION,
  allCodes,
  allModes,
  byFamily,
  causalDistance,
  causes,
  familyOf,
  getMode,
  isCausedBy,
  modesByObservedFrequency,
  requireMode,
} from './taxonomy/registry.js';

// errors
export { AnvayaError, isAnvayaError, isRetryable } from './errors/base.js';
export type { AnvayaErrorOptions, ErrorCategory, SerializedError } from './errors/base.js';
export { ERROR_CODES } from './errors/codes.js';
export type { ErrorCode } from './errors/codes.js';
export {
  AuthError,
  ConfigurationError,
  DetectorError,
  InternalError,
  NotFoundError,
  RateLimitError,
  StorageError,
  TransportError,
  ValidationError,
} from './errors/errors.js';

// logging
export { createLogger, createNoopLogger } from './logging/logger.js';
export type { LoggerOptions } from './logging/logger.js';
export { ConsoleSink, MemorySink, formatJson, formatPretty } from './logging/sinks.js';
export type { LogFormat } from './logging/sinks.js';
export { LOG_LEVELS } from './logging/types.js';
export type { LogContext, Logger, LogLevel, LogRecord, LogSink } from './logging/types.js';

// redaction
export { Redactor, defaultRedactor } from './redaction/redactor.js';
export type { RedactionResult, SecretHit } from './redaction/redactor.js';
export { defaultPatterns, luhnValid } from './redaction/patterns.js';
export type { RedactionPattern, SecretClass } from './redaction/patterns.js';

// schema
export {
  INGEST_FORMATS,
  attributeMapSchema,
  ingestPayloadSchema,
  spanRecordSchema,
} from './schema/ingest.js';
export type { IngestAck, IngestFormat, IngestPayload, IngestPayloadInput } from './schema/ingest.js';

// util
export { err, isErr, isOk, mapResult, ok, partition, unwrapOr } from './util/result.js';
export type { Result } from './util/result.js';
export {
  newFindingId,
  newId,
  newIncidentId,
  newRequestId,
  newSpanId,
  newTraceId,
  stableHash,
} from './util/id.js';
export {
  PSI_MODERATE,
  PSI_SIGNIFICANT,
  SAMPLE_RESERVOIR,
  WelfordAccumulator,
  histogram,
  jensenShannon,
  mad,
  maxOf,
  mean,
  median,
  minOf,
  modifiedZScore,
  normalisedEntropy,
  percentile,
  psi,
} from './util/stats.js';
export {
  contentTokens,
  estimateTokens,
  jaccard,
  longestCommonSubstring,
  longestRepeatedNgram,
  ngramRepetitionRatio,
  overlapRatio,
  splitSentences,
  tokenize,
  truncate,
} from './util/text.js';
export { DAY, HOUR, MINUTE, SECOND, backoffDelay, bucketStart, now, sleep, withTimeout } from './util/time.js';
