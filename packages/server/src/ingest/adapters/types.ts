import type { IngestFormat, Result, SpanRecord, ValidationError } from '@anvaya/core';

export interface AdaptContext {
  readonly service: string;
  readonly environment: string;
  readonly sessionId?: string;
}

/**
 * Wire-format adapter (ADR-0002).
 *
 * Because the OTel GenAI conventions are explicitly pre-stable, a spec rename must
 * touch one adapter and nothing else. Adapters therefore also preserve unknown
 * attributes verbatim (IF-2.2) so a rename degrades to "present but unmapped"
 * rather than to data loss.
 */
export interface SpanAdapter {
  readonly format: IngestFormat;
  adapt(raw: unknown, ctx: AdaptContext): Result<SpanRecord, ValidationError>;
}
