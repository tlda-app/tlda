import { useState, useEffect, useRef, useMemo } from 'react'
import { useEditor } from 'tldraw'
import { onBuildProgressSignal } from '../useYjsSync'
import type { SvgDocument } from '../svgDocumentLoader'
import { buildProgressLabel } from './build-progress-label.mjs'
import { sourceActivityFromEvents } from './source-activity-from-events'
import { useFleetEvents } from '../fleet-data-adapter'
import { getAgents } from '../fleet/fleet-data.mjs'
import './BuildProgressPill.css'

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

  // Who is editing this file, and who last changed it -- read off the events the
  // client already receives. Skip: "you can just push to the pill like we push
  // to chat", "it's just a different filter on events".
  //
  // This replaced a /:name/source-activity route polled every 1000ms per open
  // file, and then a bespoke signal:source-activity broadcast that was a second
  // push mechanism beside the one already here. Both are deleted.
  const events = useFleetEvents()
  const sourceActivity = useMemo(() => {
    if (!sourceFile) return null
    const agents = getAgents() || []
    const nameOf = (id: string) =>
      agents.find((a: any) => a?.id === id)?.friendly_name || id
    return sourceActivityFromEvents(events, document.name, sourceFile, nameOf)
  }, [events, document.name, sourceFile])

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
