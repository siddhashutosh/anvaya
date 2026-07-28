#!/usr/bin/env node
/* eslint-disable no-console -- the CLI is a user-facing terminal program. */

/**
 * anvaya serve | migrate | seed  (FR-8.7)
 */

import { createLogger } from '@anvaya/core';
import { loadConfig } from './config/loader.js';
import { generateSeedTraces } from './seed/generator.js';
import { createServer, installProcessHandlers } from './server.js';

const USAGE = `
anvaya — AI failure observability

Usage:
  anvaya serve                 Start the collector and API server
  anvaya migrate               Create or upgrade the database schema
  anvaya seed [--traces N]     Populate a demo dataset (default 120 traces)

Environment:
  ANVAYA_PORT, ANVAYA_HOST, ANVAYA_DB_PATH, ANVAYA_API_KEY,
  ANVAYA_LOG_LEVEL, ANVAYA_LOG_FORMAT, ANVAYA_JUDGE_ENABLED, ANTHROPIC_API_KEY
`;

async function main(): Promise<void> {
  const [command = 'serve', ...rest] = process.argv.slice(2);

  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case 'serve':
      return serve();
    case 'migrate':
      return migrate();
    case 'seed':
      return seed(rest);
    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

async function serve(): Promise<void> {
  const server = await createServer();
  installProcessHandlers(server);
  await server.listen();
}

async function migrate(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    name: 'anvaya.migrate',
    level: config.logging.level,
    format: 'pretty',
  });
  const { createStorage } = await import('./storage/index.js');
  const storage = createStorage(config, logger);
  await storage.init();
  await storage.close();
  console.log(`Schema is up to date at ${config.storage.path}`);
}

async function seed(args: readonly string[]): Promise<void> {
  const countArg = args.indexOf('--traces');
  const count = countArg >= 0 ? Number(args[countArg + 1] ?? '120') : 120;
  if (!Number.isFinite(count) || count <= 0) {
    console.error('--traces must be a positive number');
    process.exitCode = 1;
    return;
  }

  const server = await createServer();
  const traces = generateSeedTraces({ count });

  console.log(`Seeding ${traces.length} traces through the full analysis pipeline…`);

  let findings = 0;
  for (const { trace, spans } of traces) {
    const outcome = await server.pipeline.analyze(trace, spans);
    findings += outcome.findings.length;
  }

  await server.baselines.flush();
  await server.shutdown();

  console.log(`Done. ${traces.length} traces, ${findings} findings.`);
  console.log('Start the server with `npm start` and open the dashboard to explore them.');
}

main().catch((error: unknown) => {
  console.error('anvaya failed to start:', error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});
