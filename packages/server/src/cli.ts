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
  anvaya seed --endpoint URL   Seed a REMOTE collector through its ingest API,
                               for a deployment whose database is not reachable
                               locally. Add --api-key if it is authenticated.

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

  const endpointArg = args.indexOf('--endpoint');
  if (endpointArg >= 0) {
    const endpoint = args[endpointArg + 1];
    if (!endpoint) {
      console.error('--endpoint requires a URL');
      process.exitCode = 1;
      return;
    }
    return seedRemote(endpoint, count, args);
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

/**
 * Seed a REMOTE collector over its ingest API.
 *
 * Used to populate a deployment whose database is not reachable from here —
 * a managed Postgres secret is injected at runtime and never exposed locally.
 * Going through the API is also the more honest path: it exercises validation,
 * redaction and inline analysis exactly as a real client would.
 */
async function seedRemote(
  endpoint: string,
  count: number,
  args: readonly string[],
): Promise<void> {
  const keyArg = args.indexOf('--api-key');
  const apiKey = keyArg >= 0 ? args[keyArg + 1] : process.env.ANVAYA_API_KEY;

  const base = endpoint.replace(/\/+$/, '');
  const traces = generateSeedTraces({ count });

  // Small batches: the collector analyses every completed trace inside the
  // request, so an oversized batch risks the host's function timeout.
  const TRACES_PER_REQUEST = 3;
  console.log(`Seeding ${traces.length} traces to ${base} …`);

  let accepted = 0;
  let rejected = 0;
  let analysed = 0;

  for (let i = 0; i < traces.length; i += TRACES_PER_REQUEST) {
    const chunk = traces.slice(i, i + TRACES_PER_REQUEST);
    const spans = chunk.flatMap((t) => t.spans);
    const sessionId = chunk[0]?.trace.sessionId;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const response = await fetch(`${base}/v1/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        format: 'anvaya',
        service: chunk[0]?.trace.service ?? 'support-assistant',
        environment: chunk[0]?.trace.environment ?? 'production',
        ...(sessionId ? { sessionId } : {}),
        spans,
      }),
    });

    if (!response.ok) {
      console.error(`  batch ${i / TRACES_PER_REQUEST}: HTTP ${response.status}`);
      console.error(`  ${(await response.text()).slice(0, 300)}`);
      process.exitCode = 1;
      return;
    }

    const ack = (await response.json()) as {
      accepted: number;
      rejected: number;
      analysed?: number;
      errors?: { message: string }[];
    };
    accepted += ack.accepted;
    rejected += ack.rejected;
    analysed += ack.analysed ?? 0;

    if (ack.rejected > 0) {
      console.error(`  rejected ${ack.rejected}: ${ack.errors?.[0]?.message ?? 'unknown'}`);
    }
    process.stdout.write(`\r  ${Math.min(i + TRACES_PER_REQUEST, traces.length)}/${traces.length}`);
  }

  console.log(
    `\nDone. ${accepted} spans accepted, ${rejected} rejected, ${analysed} traces analysed.`,
  );
  console.log(`Open ${base} to explore them.`);
}

main().catch((error: unknown) => {
  console.error('anvaya failed to start:', error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});
