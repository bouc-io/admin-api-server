/**
 * Prometheus metrics for this service (exposed at GET /metrics).
 *
 * Scraped by Prometheus via the chart's `prometheus.io/scrape` pod annotation.
 * This is the direct-scrape path; OTLP runtime/HTTP metrics also flow through the
 * OTel collector (lib/tracing.ts) and appear `otel_`-prefixed in Prometheus.
 *
 * Default (process/node) metrics only — labelled with `service` + `environment`
 * to line up with the collector-stamped `otel_*` series in Grafana.
 */
import client from 'prom-client';

export const register = new client.Registry();
register.setDefaultLabels({
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  service: process.env.OTEL_SERVICE_NAME || (require('../../package.json') as { name: string }).name,
  environment: process.env.ENVIRONMENT_ID || 'unknown',
});
client.collectDefaultMetrics({ register });
