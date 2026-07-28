import type { IngestFormat } from '@anvaya/core';
import { AnvayaAdapter } from './anvaya.js';
import { OpenInferenceAdapter } from './openinference.js';
import { OtelGenAiAdapter } from './otel-genai.js';
import type { SpanAdapter } from './types.js';

export type { AdaptContext, SpanAdapter } from './types.js';
export { AnvayaAdapter } from './anvaya.js';
export { OtelGenAiAdapter } from './otel-genai.js';
export { OpenInferenceAdapter } from './openinference.js';

const ADAPTERS: Readonly<Record<IngestFormat, SpanAdapter>> = {
  anvaya: new AnvayaAdapter(),
  'otel-genai': new OtelGenAiAdapter(),
  openinference: new OpenInferenceAdapter(),
};

/** Format is validated by the ingest schema, so this lookup always succeeds. */
export function getAdapter(format: IngestFormat): SpanAdapter {
  return ADAPTERS[format];
}
