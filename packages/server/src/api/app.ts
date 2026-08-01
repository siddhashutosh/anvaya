import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@anvaya/core';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config/schema.js';
import { notFoundJson, registerMiddleware } from './middleware.js';
import { registerRoutes, type RouteDeps } from './routes.js';

/**
 * Locate the built dashboard.
 *
 * Checked relative to this file (workspace layout) and to the working directory
 * (installed layout), so `npm start` serves the UI in both without configuration.
 */
function findUiBundle(configured?: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    configured,
    resolve(here, '../../../ui/dist'),
    resolve(process.cwd(), 'packages/ui/dist'),
    resolve(process.cwd(), 'ui'),
  ].filter((p): p is string => typeof p === 'string');

  return candidates.find((path) => existsSync(resolve(path, 'index.html')));
}

export interface AppDeps extends RouteDeps {
  readonly logger: Logger;
}

export async function createApp(deps: AppDeps): Promise<FastifyInstance> {
  const config: Config = deps.config;

  const app = Fastify({
    // Fastify's own logger is disabled: all output goes through the Anvaya
    // logger so redaction and correlation apply uniformly (LG-6, LG-11).
    logger: false,
    bodyLimit: config.server.bodyLimitBytes,
  });

  await app.register(cors, {
    origin: config.server.corsOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization'],
  });

  registerMiddleware(app, config, deps.logger);
  registerRoutes(app, deps);

  // Single-origin deployment: the collector serves the dashboard itself, so a
  // production install is one process on one port with no CORS involved. This
  // is the topology the HLD describes; without it the built UI had no host.
  const uiRoot = config.server.serveUi ? findUiBundle(config.server.uiPath) : undefined;

  if (uiRoot) {
    await app.register(fastifyStatic, { root: uiRoot, wildcard: false });
    deps.logger.info('serving dashboard', { uiRoot });
  } else if (config.server.serveUi) {
    deps.logger.info('dashboard bundle not found; serving API only', {
      hint: 'run `npm run build` to build the UI',
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    // API paths keep the JSON envelope. Anything else is a client-side route and
    // must fall through to the SPA shell, so a deep link survives a refresh.
    const isApiPath =
      path.startsWith('/v1/') || path === '/health' || path.startsWith('/api/');

    if (!uiRoot || isApiPath || request.method !== 'GET') {
      notFoundJson(request, reply);
      return;
    }
    void reply.sendFile('index.html');
  });

  return app;
}
