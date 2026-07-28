/**
 * Alert dispatch (FR-8.5). Off by default; a webhook is the only built-in channel.
 *
 * Alert payloads carry taxonomy codes and remediation, not raw content — an alert
 * lands in Slack, which is a much wider audience than the dashboard.
 */

import {
  AnvayaError,
  ERROR_CODES,
  SEVERITY_RANK,
  err,
  getMode,
  ok,
  withTimeout,
  type Incident,
  type Logger,
  type Result,
  type Severity,
} from '@anvaya/core';
import type { Config } from '../config/schema.js';

export interface Alert {
  readonly incident: Incident;
  readonly remediation: string;
  readonly taxonomyName: string;
}

export interface AlertChannel {
  readonly name: string;
  send(alert: Alert): Promise<Result<void, AnvayaError>>;
}

export class WebhookChannel implements AlertChannel {
  readonly name = 'webhook';

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
  ) {}

  async send(alert: Alert): Promise<Result<void, AnvayaError>> {
    try {
      const response = await withTimeout(
        fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: `[${alert.incident.severity.toUpperCase()}] ${alert.taxonomyName} — ${alert.incident.originOperation}`,
            incident: {
              id: alert.incident.incidentId,
              code: alert.incident.code,
              name: alert.taxonomyName,
              severity: alert.incident.severity,
              occurrences: alert.incident.occurrences,
              firstSeen: new Date(alert.incident.firstSeen).toISOString(),
              operation: alert.incident.originOperation,
              hypothesis: alert.incident.hypothesis,
              remediation: alert.remediation,
            },
          }),
        }),
        this.timeoutMs,
        () =>
          new AnvayaError('alert webhook timed out', {
            code: ERROR_CODES.TRANSPORT_TIMEOUT,
            category: 'transport',
            retryable: true,
          }),
      );

      if (!response.ok) {
        return err(
          new AnvayaError(`alert webhook returned ${response.status}`, {
            code: ERROR_CODES.TRANSPORT_FAILED,
            category: 'transport',
            retryable: response.status >= 500,
            context: { status: response.status },
          }),
        );
      }
      return ok(undefined);
    } catch (e) {
      return err(
        AnvayaError.from(e, {
          code: ERROR_CODES.TRANSPORT_FAILED,
          category: 'transport',
          retryable: true,
        }),
      );
    }
  }
}

export class AlertDispatcher {
  private readonly channels: AlertChannel[] = [];
  private readonly logger: Logger;
  /** Incident ids already alerted on, so an ongoing incident pages once. */
  private readonly alerted = new Set<string>();

  constructor(
    private readonly config: Config,
    logger: Logger,
  ) {
    this.logger = logger.child('alerts');
    if (config.alerts.enabled && config.alerts.webhookUrl) {
      this.channels.push(new WebhookChannel(config.alerts.webhookUrl, config.alerts.timeoutMs));
    }
  }

  addChannel(channel: AlertChannel): void {
    this.channels.push(channel);
  }

  async dispatch(incident: Incident): Promise<void> {
    if (!this.config.alerts.enabled || this.channels.length === 0) return;

    const floor = SEVERITY_RANK[this.config.alerts.minSeverity as Severity];
    if (SEVERITY_RANK[incident.severity] < floor) return;
    if (this.alerted.has(incident.incidentId)) return;
    this.alerted.add(incident.incidentId);

    const mode = getMode(incident.code);
    const alert: Alert = {
      incident,
      remediation: mode?.remediation ?? 'See the Anvaya taxonomy for guidance.',
      taxonomyName: mode?.name ?? incident.code,
    };

    for (const channel of this.channels) {
      const result = await channel.send(alert);
      if (!result.ok) {
        // An alert failure must not fail the pipeline that produced it.
        this.logger.warn('alert channel failed', {
          err: result.error,
          channel: channel.name,
          incidentId: incident.incidentId,
        });
      } else {
        this.logger.info('alert dispatched', {
          channel: channel.name,
          incidentId: incident.incidentId,
          taxonomyCode: incident.code,
        });
      }
    }
  }
}
