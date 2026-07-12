import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'

function envEnabled() {
  if (process.env.TLDA_OTEL && process.env.TLDA_OTEL !== '0' && process.env.TLDA_OTEL !== 'false') return true
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return true
  if (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return true
  if (process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) return true
  if (process.env.OTEL_TRACES_EXPORTER || process.env.OTEL_METRICS_EXPORTER) return true
  return false
}

let sdk = null

if (envEnabled()) {
  const serviceName = process.env.OTEL_SERVICE_NAME || process.env.TLDA_OTEL_SERVICE_NAME || 'tlda-server'
  process.env.OTEL_SERVICE_NAME = serviceName

  const enableMetrics = process.env.TLDA_OTEL_METRICS !== '0' && process.env.OTEL_METRICS_EXPORTER !== 'none'
  sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter(),
    metricReader: enableMetrics
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
        })
      : undefined,
    instrumentations: [getNodeAutoInstrumentations()],
  })

  Promise.resolve(sdk.start()).catch(err => {
    console.warn(`[otel] failed to start OpenTelemetry SDK: ${err?.message || err}`)
  })

  const shutdown = () => {
    Promise.resolve(sdk?.shutdown?.()).catch(err => {
      console.warn(`[otel] failed to shutdown OpenTelemetry SDK: ${err?.message || err}`)
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

export function isOtelEnabled() {
  return !!sdk
}
