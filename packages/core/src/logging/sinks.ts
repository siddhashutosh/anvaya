/* eslint-disable no-console -- this file IS the console boundary; all other library code must go through Logger (LG-11). */

import type { LogLevel, LogRecord, LogSink } from './types.js';

export type LogFormat = 'json' | 'pretty';

const LEVEL_COLOURS: Readonly<Record<LogLevel, string>> = Object.freeze({
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[35m',
});
const RESET = '\x1b[0m';

export function formatJson(record: LogRecord): string {
  try {
    return JSON.stringify(record);
  } catch {
    // Context contained something unserialisable. Never let formatting fail a log.
    return JSON.stringify({
      timestamp: record.timestamp,
      level: record.level,
      logger: record.logger,
      message: record.message,
      context: { _note: 'context omitted: not serialisable' },
    });
  }
}

export function formatPretty(record: LogRecord): string {
  const colour = LEVEL_COLOURS[record.level] ?? '';
  const time = record.timestamp.slice(11, 23);
  const level = record.level.toUpperCase().padEnd(5);
  const head = `${colour}${time} ${level}${RESET} [${record.logger}] ${record.message}`;

  const parts: string[] = [head];
  const ctx = Object.entries(record.context).filter(([, v]) => v !== undefined);
  if (ctx.length > 0) {
    const rendered = ctx
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : safeStringify(v)}`)
      .join(' ');
    parts.push(`  ${'\x1b[90m'}${rendered}${RESET}`);
  }
  if (record.error && record.error.length > 0) {
    for (const e of record.error) {
      parts.push(`  ${'\x1b[31m'}${e.name}: ${e.message} (${e.code})${RESET}`);
      if (e.stack) parts.push(`  ${'\x1b[90m'}${e.stack.split('\n').slice(1, 4).join('\n')}${RESET}`);
    }
  }
  return parts.join('\n');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserialisable]';
  }
}

/**
 * Console sink. Writes to stderr for warn and above so log streams can be split.
 * Disables itself after repeated write failures rather than throwing (LG-8).
 */
export class ConsoleSink implements LogSink {
  readonly name = 'console';
  private failures = 0;
  private disabled = false;

  constructor(private readonly format: LogFormat = 'json') {}

  write(record: LogRecord): void {
    if (this.disabled) return;
    try {
      const line = this.format === 'pretty' ? formatPretty(record) : formatJson(record);
      if (record.level === 'warn' || record.level === 'error' || record.level === 'fatal') {
        process.stderr.write(line + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
      this.failures = 0;
    } catch {
      this.failures++;
      if (this.failures >= 5) this.disabled = true;
    }
  }
}

/** In-memory sink for tests and for the /health diagnostics buffer. */
export class MemorySink implements LogSink {
  readonly name = 'memory';
  private readonly records: LogRecord[] = [];

  constructor(private readonly capacity = 500) {}

  write(record: LogRecord): void {
    this.records.push(record);
    if (this.records.length > this.capacity) this.records.shift();
  }

  all(): readonly LogRecord[] {
    return this.records;
  }

  clear(): void {
    this.records.length = 0;
  }
}
