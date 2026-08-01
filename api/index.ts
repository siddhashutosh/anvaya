/**
 * Vercel serverless entry point.
 *
 * Wraps the same Fastify app the self-hosted server runs, so there is exactly
 * one implementation of routing, auth, the error envelope and detection — the
 * serverless deployment is a different *host*, not a different product.
 *
 * The app is built once per warm instance and reused; `app.ready()` is awaited
 * before the first request is emitted into Fastify's own HTTP handler.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type AnvayaServer } from '@anvaya/server';

let cached: Promise<AnvayaServer> | undefined;

async function boot(): Promise<AnvayaServer> {
  const server = await createServer();
  await server.app.ready();
  return server;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Reused across invocations on a warm instance; rebuilt after a cold start.
  cached ??= boot().catch((error: unknown) => {
    // Do not cache a failed boot — a transient database problem would otherwise
    // poison the instance for its whole lifetime.
    cached = undefined;
    throw error;
  });

  const server = await cached;
  server.app.server.emit('request', req, res);
}
