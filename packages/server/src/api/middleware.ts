/**
 * API middleware: request id, auth, and the single error boundary.
 *
 * `errorBoundary` is the only place an error becomes an HTTP response (EH-7), so
 * the envelope shape and the no-stacks-in-production rule are enforced in one
 * spot rather than in every handler.
 */

import { timingSafeEqual } from 'node:crypto';
import {
  AnvayaError,
  AuthError,
  ERROR_CODES,
  newRequestId,
  type Logger,
} from '@anvaya/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config/schema.js';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    log0: Logger;
  }
}

const PUBLIC_PATHS = new Set(['/health', '/v1/meta']);

export function registerMiddleware(app: FastifyInstance, config: Config, logger: Logger): void {
  // Request id on every request and response (FR-6.12, LG-5).
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = newRequestId();
    request.requestId = requestId;
    request.log0 = logger.child('http', { requestId });
    void reply.header('x-request-id', requestId);
  });

  // Auth (FR-2.10). Skipped for health/meta so liveness never depends on a secret.
  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (!config.ingest.apiKey) return;
    if (PUBLIC_PATHS.has(request.url.split('?')[0] ?? '')) return;

    const header = request.headers.authorization;
    const provided = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
    if (!constantTimeEqual(provided, config.ingest.apiKey)) {
      throw new AuthError('missing or invalid API key', {
        code: provided ? ERROR_CODES.AUTH_INVALID : ERROR_CODES.AUTH_MISSING,
        // The key itself is never logged or echoed (NFR-4.5).
        context: { path: request.url },
      });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    errorBoundary(error, request, reply, config, logger);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: {
        code: ERROR_CODES.NOT_FOUND,
        message: `No route for ${request.method} ${request.url}`,
        requestId: request.requestId ?? 'unknown',
      },
    });
  });
}

export function errorBoundary(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  logger: Logger,
): void {
  const typed = AnvayaError.from(error, {
    code: ERROR_CODES.INTERNAL,
    category: 'internal',
    context: { path: request.url, method: request.method },
  });

  const log = request.log0 ?? logger;
  if (typed.httpStatus >= 500) {
    log.error('request failed', { err: typed, path: request.url, method: request.method });
  } else {
    log.warn('request rejected', {
      err: typed,
      path: request.url,
      status: typed.httpStatus,
    });
  }

  const payload: Record<string, unknown> = {
    code: typed.code,
    message: typed.message,
    requestId: request.requestId ?? 'unknown',
  };

  if (Array.isArray(typed.context.details)) payload.details = typed.context.details;
  // Stacks only in dev mode (NFR-4.6).
  if (config.server.devMode && typed.stack) payload.stack = typed.stack;

  void reply.code(typed.httpStatus).send({ error: payload });
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) {
    // Compare against itself to keep the timing profile roughly constant.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
