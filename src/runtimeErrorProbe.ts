import { useEffect } from 'react'
import { appendToken } from './authToken'
import { fetchDocumentManifest } from './loaders/documentFormatLoader'
import { onReloadSignal, isSignalConnected } from './useYjsSync'
import { hasRuntimeProbeBasePath, subscribeRuntimeProbe } from './runtimeErrorProbeCore'

// This is deliberately client-connected coverage, not publish validation. A
// rebuild with no viewer in its document room has no signal recipient and is
// therefore not eagerly loaded here.
type ProbeDocument = { name: string; basePath?: string }

export function startRuntimeErrorProbe(document: ProbeDocument) {
  if (!hasRuntimeProbeBasePath(document)) return () => {}
  return subscribeRuntimeProbe(document, {
    onReload: onReloadSignal,
    isConnected: isSignalConnected,
    fetchManifest: fetchDocumentManifest,
    appendUrlToken: appendToken,
  })
}

export function useRuntimeErrorProbe(document: ProbeDocument) {
  useEffect(() => startRuntimeErrorProbe(document), [document.name, document.basePath])
}
