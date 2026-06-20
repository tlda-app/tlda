import { useEffect, useState } from 'react'
import { getPref, subscribePref } from './preferences'

export function useProvenanceMode(): string {
  const [mode, setMode] = useState(() => getPref('provenance-display-mode'))

  useEffect(() => subscribePref(() => setMode(getPref('provenance-display-mode'))), [])

  return mode
}
