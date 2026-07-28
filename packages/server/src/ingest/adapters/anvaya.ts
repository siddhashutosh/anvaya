/** Native format adapter: validate against the shared schema and pass through. */

import {
  ERROR_CODES,
  ValidationError,
  err,
  ok,
  spanRecordSchema,
  type Result,
  type SpanRecord,
} from '@anvaya/core';
import type { AdaptContext, SpanAdapter } from './types.js';

export class AnvayaAdapter implements SpanAdapter {
  readonly format = 'anvaya' as const;

  adapt(raw: unknown, _ctx: AdaptContext): Result<SpanRecord, ValidationError> {
    const parsed = spanRecordSchema.safeParse(raw);
    if (!parsed.success) {
      const details = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return err(
        new ValidationError(`invalid span: ${details}`, {
          code: ERROR_CODES.INVALID_SPAN,
          context: { issues: parsed.error.issues.length },
        }),
      );
    }
    return ok(parsed.data as SpanRecord);
  }
}
