import { useState, useEffect, useRef } from 'react'
import { useEditor } from 'tldraw'
import { onBuildProgressSignal } from '../useYjsSync'
import { appendToken } from '../authToken'
import type { SvgDocument } from '../svgDocumentLoader'
import { buildProgressLabel } from './build-progress-label.mjs'
import './BuildProgressPill.css'

type SourceActivity = {
  editors: Array<{ id: string; name: string }>
  lastChangedAt: number | null
  lastChangedBy: string | null
}

function timeLabel(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp)
}

export function BuildProgressPill({ document }: { document: SvgDocument }) {
  const editor = useEditor()
  const [phase, setPhase] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [sourceFile, setSourceFile] = useState<string | null>(null)
  const [sourceActivity, setSourceActivity] = useState<SourceActivity | null>(null)

  useEffect(() => {
    const read = () => {
      const pageId = editor.getCurrentPageId()
      const candidates = [...document.pages, ...(document.partPages || [])]
        .filter(page => page.tldrawPageId === pageId && /\.(?:md|markdown)$/i.test(page.source?.file || ''))
      setSourceFile(candidates[0]?.source?.file || null)
    }
    read()
    return editor.store.listen(read, { scope: 'session', source: 'all' })
  }, [document, editor])

  useEffect(() => {
    if (!sourceFile) {
      setSourceActivity(null)
      return
    }
    let cancelled = false
    const read = async () => {
      try {
        const url = appendToken(`/api/projects/${encodeURIComponent(document.name)}/source-activity?file=${encodeURIComponent(sourceFile)}`)
        const response = await fetch(url)
        if (!response.ok) return
        const activity = await response.json()
        if (!cancelled) setSourceActivity(activity)
      } catch { /* a later poll repairs transient disconnects */ }
    }
    void read()
    const interval = window.setInterval(read, 1000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [document.name, sourceFile])

  useEffect(() => {
    return onBuildProgressSignal((signal) => {
      let label = ''
      let detail = signal.detail
      switch (signal.phase) {
        case 'compiling':  label = 'compiling';  break
        case 'converting': break
        case 'hot':        break
        case 'done':       label = 'compiling'; detail = `done ${signal.detail || ''}`.trim(); break
        case 'failed':     label = 'failed';     break
      }
      if (!label) return
      setPhase(label)
      setDetail(detail)
      setVisible(true)

      if (fadeTimer.current) clearTimeout(fadeTimer.current)

      if (signal.phase === 'done' || signal.phase === 'failed') {
        fadeTimer.current = setTimeout(() => {
          setVisible(false)
          fadeTimer.current = null
        }, 4000)
      }
    })
  }, [])

  let activityLabel = ''
  if (sourceActivity?.editors?.length) {
    const names = sourceActivity.editors.map(editor => editor.name)
    activityLabel = names.length === 1 ? `${names[0]} is editing` : `${names.join(', ')} are editing`
  } else if (sourceActivity?.lastChangedAt && sourceActivity.lastChangedBy) {
    activityLabel = `Not being edited · last changed ${timeLabel(sourceActivity.lastChangedAt)} by ${sourceActivity.lastChangedBy}`
  }

  const label = buildProgressLabel({ visible, phase, detail, activityLabel })
  if (!label) return null

  return (
    <span className="build-progress-text" onPointerDown={e => e.stopPropagation()}>
      {label}
    </span>
  )
}
