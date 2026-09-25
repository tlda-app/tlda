/**
 * BuildCurrencyPill — always-visible rendered-vs-saved build state.
 *
 * Display only. The rendered side comes from the doc-version sentinel shape
 * in the Yjs store (sourceRevision/acceptSeq, written by every successful
 * build); the saved side comes from the project record the app already
 * fetches (GET /api/projects/:name via fetchDocConfig). The verdict itself
 * is describeBuildCurrency() in ./build-currency.mjs. No writes, no queue
 * polling, no recovery: when the render lags the source the pill says so
 * loudly, which is the whole job.
 */
import { useEffect, useState } from 'react'
import { useEditor } from 'tldraw'
import type { TLShapeId } from 'tldraw'
import { fetchDocConfig } from '../pageSource'
import { onBuildProgressSignal } from '../useYjsSync'
import { describeBuildCurrency } from './build-currency.mjs'
import './BuildCurrencyPill.css'

type SentinelBuild = {
  sourceRevision?: string | null
  acceptSeq?: number | null
}

type SavedBuild = {
  sourceRevision?: string | null
  acceptSeq?: number | null
  buildStatus?: string | null
  lastBuild?: string | null
}

function readSentinel(editor: any): SentinelBuild | null {
  const s = editor?.store?.get?.('shape:doc-version--sentinel' as TLShapeId) as any
  const p = s?.props
  if (!p) return null
  return {
    sourceRevision: typeof p.sourceRevision === 'string' ? p.sourceRevision : null,
    acceptSeq: typeof p.acceptSeq === 'number' ? p.acceptSeq : null,
  }
}

export function BuildCurrencyPill({ projectName }: { projectName: string }) {
  const editor = useEditor()
  const [rendered, setRendered] = useState<SentinelBuild | null>(null)
  const [saved, setSaved] = useState<SavedBuild | null>(null)

  // Rendered side: reactive on the sentinel, the same convergent state the
  // error and warning pills already read.
  useEffect(() => {
    if (!editor) return
    setRendered(readSentinel(editor))
    return editor.store.listen(() => setRendered(readSentinel(editor)), { scope: 'all' })
  }, [editor])

  // Saved side: the project record, re-read so a save with no following
  // build shows up here within seconds rather than at the next reload.
  useEffect(() => {
    let cancelled = false
    const read = async () => {
      try {
        const config = await fetchDocConfig(projectName)
        if (cancelled || !config) return
        setSaved({
          sourceRevision: config.sourceRevision ?? null,
          acceptSeq: typeof config.acceptSeq === 'number' ? config.acceptSeq : null,
          buildStatus: config.buildStatus ?? null,
          lastBuild: config.lastBuild ?? null,
        })
      } catch {
        // A failed refresh leaves the last reading on screen rather than
        // blanking the pill: no reading is not "current".
      }
    }
    void read()
    // A build starting is the moment the render starts lagging: the progress
    // signal the chrome already consumes refreshes the saved side within a
    // second, instead of whenever the backstop poll below happens to fire.
    // The interval stays as the backstop for a save whose build never starts.
    const offProgress = onBuildProgressSignal(() => void read())
    const timer = setInterval(() => void read(), 5000)
    return () => { cancelled = true; offProgress(); clearInterval(timer) }
  }, [projectName])

  const verdict = describeBuildCurrency({
    renderedRevision: rendered?.sourceRevision ?? null,
    renderedSeq: rendered?.acceptSeq ?? null,
    savedRevision: saved?.sourceRevision ?? null,
    savedSeq: saved?.acceptSeq ?? null,
    status: saved?.buildStatus ?? null,
    lastBuild: saved?.lastBuild ?? null,
  })

  return (
    <span
      className={`build-currency${verdict.loud ? ' stale' : ''}`}
      data-build-state={verdict.state}
      title={verdict.title}
      onPointerDown={e => e.stopPropagation()}
    >
      {verdict.label}
    </span>
  )
}
