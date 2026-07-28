import cors from '@fastify/cors';
import type { Logger } from '@anvaya/core';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config/schema.js';
import { registerMiddleware } from './middleware.js';
import { registerRoutes, type RouteDeps } from './routes.js';

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

  return app;
}
