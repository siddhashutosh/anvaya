/**
 * Self-telemetry (FR-8.4). In-memory counters and histograms, exposed via /health.
 *
 * An observability tool with no visibility into itself is an obvious hypocrisy,
 * and dropped spans in particular must never be silent.
 */

export type Labels = Readonly<Record<string, string>>;

interface Histogram {
  count: number;
  sum: number;
  min: number;
  max: number;
}

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly gauges: Readonly<Record<string, number>>;
  readonly histograms: Readonly<
    Record<string, { count: number; sum: number; mean: number; min: number; max: number }>
  >;
  readonly uptimeMs: number;
}

function seriesKey(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return `${name}{${parts}}`;
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly startedAt = Date.now();

  counter(name: string, delta = 1, labels?: Labels): void {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + delta);
  }

  gauge(name: string, value: number, labels?: Labels): void {
    this.gauges.set(seriesKey(name, labels), value);
  }

  observe(name: string, value: number, labels?: Labels): void {
    if (!Number.isFinite(value)) return;
    const key = seriesKey(name, labels);
    const h = this.histograms.get(key);
    if (!h) {
      this.histograms.set(key, { count: 1, sum: value, min: value, max: value });
      return;
    }
    h.count++;
    h.sum += value;
    if (value < h.min) h.min = value;
    if (value > h.max) h.max = value;
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(
        [...this.histograms.entries()].map(([k, h]) => [
          k,
          { count: h.count, sum: h.sum, mean: h.count === 0 ? 0 : h.sum / h.count, min: h.min, max: h.max },
        ]),
      ),
      uptimeMs: Date.now() - this.startedAt,
    };
  }
}
