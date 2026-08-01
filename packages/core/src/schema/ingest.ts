/**
 * Zod schemas for the ingest wire payload (FR-2.2).
 *
 * Kept in `core` rather than in the server so the SDK validates the same shape it
 * sends — a mismatch becomes a compile/test failure rather than a 400 in production.
 */

import { z } from 'zod';
import { SPAN_KINDS } from '../types/span.js';

/**
 * Array bounds at the trust boundary.
 *
 * The batch size was capped but the arrays *inside* a span were not, so a single
 * span could carry an unbounded document or message list. Everything downstream
 * — grouping, spreads, JSON serialisation — then inherits that unboundedness
 * from untrusted input.
 */
const MAX_DOCUMENTS = 1000;
const MAX_MESSAGES = 2000;
const MAX_EVENTS = 1000;
const MAX_TOOL_NAMES = 500;

export const attributeValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number()),
]);

export const attributeMapSchema = z.record(attributeValueSchema);

export const spanEventSchema = z.object({
  name: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
  attributes: attributeMapSchema.optional(),
});

export const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        arguments: z.string().optional(),
      }),
    )
    .optional(),
});

export const llmPayloadSchema = z.object({
  provider: z.string().optional(),
  requestModel: z.string().optional(),
  responseModel: z.string().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  finishReason: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
  contextLimit: z.number().int().positive().optional(),
  systemInstructions: z.string().optional(),
  inputMessageCount: z.number().int().nonnegative().optional(),
  inputMessages: z.array(chatMessageSchema).max(MAX_MESSAGES).optional(),
  outputMessages: z.array(chatMessageSchema).max(MAX_MESSAGES).optional(),
  reasoningText: z.string().optional(),
  costUsd: z.number().nonnegative().optional(),
});

export const retrievedDocumentSchema = z.object({
  id: z.string(),
  score: z.number().optional(),
  content: z.string().optional(),
  metadata: attributeMapSchema.optional(),
  timestamp: z.number().int().nonnegative().optional(),
});

export const retrievalPayloadSchema = z.object({
  query: z.string().optional(),
  indexName: z.string().optional(),
  topK: z.number().int().positive().optional(),
  scoreThreshold: z.number().optional(),
  documents: z.array(retrievedDocumentSchema).max(MAX_DOCUMENTS).optional(),
});

export const toolPayloadSchema = z.object({
  toolName: z.string().min(1),
  toolType: z.enum(['function', 'extension', 'datastore']).optional(),
  arguments: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  attempt: z.number().int().positive().optional(),
  mutating: z.boolean().optional(),
  privileged: z.boolean().optional(),
  parameterSchema: z.unknown().optional(),
  availableTools: z.array(z.string()).max(MAX_TOOL_NAMES).optional(),
});

export const agentPayloadSchema = z.object({
  agentName: z.string().optional(),
  agentRole: z.string().optional(),
  objective: z.string().optional(),
  iteration: z.number().int().nonnegative().optional(),
  maxIterations: z.number().int().positive().optional(),
  declaredSubtasks: z.array(z.string()).optional(),
  completedSubtasks: z.array(z.string()).optional(),
  terminated: z.boolean().optional(),
  reasoningText: z.string().optional(),
});

export const spanRecordSchema = z.object({
  spanId: z.string().min(1).max(64),
  traceId: z.string().min(1).max(64),
  parentSpanId: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(256),
  kind: z.enum(SPAN_KINDS as unknown as [string, ...string[]]),
  startTime: z.number().int().nonnegative(),
  endTime: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  status: z.enum(['ok', 'error', 'unset']),
  statusMessage: z.string().max(2000).optional(),
  attributes: attributeMapSchema.default({}),
  events: z.array(spanEventSchema).max(MAX_EVENTS).default([]),
  llm: llmPayloadSchema.optional(),
  retrieval: retrievalPayloadSchema.optional(),
  tool: toolPayloadSchema.optional(),
  agent: agentPayloadSchema.optional(),
});

export const INGEST_FORMATS = ['anvaya', 'otel-genai', 'openinference'] as const;
export type IngestFormat = (typeof INGEST_FORMATS)[number];

export const ingestPayloadSchema = z.object({
  format: z.enum(INGEST_FORMATS).default('anvaya'),
  service: z.string().min(1).max(128),
  environment: z.string().min(1).max(64).default('development'),
  sessionId: z.string().max(128).optional(),
  /** Adapters other than `anvaya` receive raw objects, so this stays permissive. */
  spans: z.array(z.unknown()).min(1).max(1000),
});

export type IngestPayloadInput = z.input<typeof ingestPayloadSchema>;
export type IngestPayload = z.output<typeof ingestPayloadSchema>;

export interface IngestAck {
  readonly accepted: number;
  readonly rejected: number;
  readonly errors: readonly { readonly index: number; readonly message: string }[];
}
