import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { stopEventPropagation } from 'tldraw'
import {
  CONDITION_ANCHOR_SELECTOR,
  CONDITION_TOPICS,
  getChromeConditions,
  subscribeChromeConditions,
  type ChromeCondition,
  type ConditionSeverity,
  type ConditionTopic,
} from './conditions'
import { useChromeConditions } from './useChromeConditions'
import './conditions.css'

/** Warning and error each get their own glyph; severe reuses the error glyph,
 * because severe IS an error — what makes it severe is the button going red,
 * not a third mark to learn. */
function ConditionGlyph({ severity }: { severity: ConditionSeverity }) {
  if (severity === 'warning') {
    return (
      <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" style={{ display: 'block' }}>
        <path
          d="M12 3.2 22 20.4H2Z"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        <path d="M12 9.4v4.6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
        <circle cx="12" cy="17.2" r="1.15" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth={2} />
      <path
        d="M8.9 8.9 15.1 15.1M15.1 8.9 8.9 15.1"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  )
}

function severityLabel(severity: ConditionSeverity): string {
  return severity === 'warning' ? 'Warning' : severity === 'severe' ? 'Severe error' : 'Error'
}

type AnchorRects = Partial<Record<ConditionTopic, DOMRect>>

function rectKey(rects: AnchorRects): string {
  return CONDITION_TOPICS.map((topic) => {
    const rect = rects[topic]
    return rect ? `${topic}:${rect.left},${rect.top},${rect.width},${rect.height}` : `${topic}:-`
  }).join('|')
}

/** The corner buttons are separately-positioned fixed elements whose offsets
 * are redeclared for phone, touch-toc and tablet with env() and viewport-unit
 * vars. Measuring them keeps conditions correct in every one of those modes
 * without a fifth copy of the ladder. */
function useAnchorRects(activeTopics: readonly ConditionTopic[]): AnchorRects {
  const [rects, setRects] = useState<AnchorRects>({})
  const keyRef = useRef('')

  const measure = useCallback(() => {
    const next: AnchorRects = {}
    for (const topic of CONDITION_TOPICS) {
      if (!activeTopics.includes(topic)) continue
      const element = document.querySelector(CONDITION_ANCHOR_SELECTOR[topic])
      if (!element) continue
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      next[topic] = rect
    }
    const key = rectKey(next)
    if (key === keyRef.current) return
    keyRef.current = key
    setRects(next)
  }, [activeTopics])

  useEffect(() => {
    measure()
    if (activeTopics.length === 0) return

    const frame = requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('scroll', measure)

    // phone-mode / touch-toc-mode are body classes, and switching one moves
    // every button. Class changes fire no resize, so watch the attribute.
    const classObserver = new MutationObserver(measure)
    classObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })

    const sizeObserver = new ResizeObserver(measure)
    for (const topic of activeTopics) {
      const element = document.querySelector(CONDITION_ANCHOR_SELECTOR[topic])
      if (element) sizeObserver.observe(element)
    }

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('scroll', measure)
      classObserver.disconnect()
      sizeObserver.disconnect()
    }
  }, [measure, activeTopics])

  return rects
}

function ConditionDetail({
  conditions,
  rect,
}: {
  conditions: ChromeCondition[]
  rect: DOMRect
}) {
  return (
    <div
      className="chrome-condition-detail"
      style={{
        bottom: `${window.innerHeight - rect.top + 8}px`,
        right: `${Math.max(window.innerWidth - rect.right, 8)}px`,
      }}
      role="status"
    >
      {conditions.map((condition) => (
        <div
          key={condition.id}
          className={`chrome-condition-detail-row chrome-condition--${condition.severity}`}
        >
          <span className="chrome-condition-detail-glyph">
            <ConditionGlyph severity={condition.severity} />
          </span>
          <span className="chrome-condition-detail-text">{condition.text}</span>
        </div>
      ))}
    </div>
  )
}

function TopicConditions({
  topic,
  rect,
  shown,
  onToggle,
  onHover,
}: {
  topic: ConditionTopic
  rect: DOMRect
  shown: boolean
  onToggle: () => void
  onHover: (hovering: boolean) => void
}) {
  const conditions = useChromeConditions(topic)
  if (conditions.length === 0) return null

  return (
    <>
      <div
        className="chrome-condition-stack"
        data-condition-topic={topic}
        style={{
          bottom: `${window.innerHeight - rect.bottom}px`,
          right: `${window.innerWidth - rect.left}px`,
          height: `${rect.height}px`,
        }}
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') onHover(true)
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') onHover(false)
        }}
      >
        {conditions.map((condition) => (
          <button
            key={condition.id}
            type="button"
            className={`chrome-condition-icon chrome-condition--${condition.severity}`}
            aria-label={`${severityLabel(condition.severity)}: ${condition.text}`}
            aria-expanded={shown}
            onPointerDown={stopEventPropagation}
            onPointerUp={stopEventPropagation}
            onTouchStart={stopEventPropagation}
            onTouchEnd={stopEventPropagation}
            onClick={(e) => {
              stopEventPropagation(e)
              onToggle()
            }}
          >
            <ConditionGlyph severity={condition.severity} />
          </button>
        ))}
      </div>
      {shown && <ConditionDetail conditions={conditions} rect={rect} />}
    </>
  )
}

/**
 * Renders every topic's leftward condition stack and the detail view above the
 * button. Mounted once in the canvas chrome; each corner button separately
 * reddens itself on 'severe' via useChromeConditionSeverity.
 */
export function ChromeConditions() {
  const [pinned, setPinned] = useState<ConditionTopic | null>(null)
  const [hovered, setHovered] = useState<ConditionTopic | null>(null)

  // Which topics are non-empty decides what gets measured and rendered. Taking
  // it as a string keeps the snapshot comparable by value, so the array below
  // holds its identity while the same topics are active — which is what lets
  // every dependency list here be honest.
  const activeKey = useSyncExternalStore(subscribeChromeConditions, () =>
    CONDITION_TOPICS.filter((topic) => getChromeConditions(topic).length > 0).join(',')
  )
  const activeTopics = useMemo(
    () => (activeKey ? (activeKey.split(',') as ConditionTopic[]) : []),
    [activeKey]
  )
  const rects = useAnchorRects(activeTopics)

  // A topic that goes silent must not leave its detail view pinned open — and
  // must not re-open it unbidden if the same topic comes back later. Adjusting
  // during render is React's own pattern for derived state like this; an effect
  // would cost a second render pass to do the same thing.
  const [seenActiveKey, setSeenActiveKey] = useState(activeKey)
  if (seenActiveKey !== activeKey) {
    setSeenActiveKey(activeKey)
    if (pinned && !activeTopics.includes(pinned)) setPinned(null)
    if (hovered && !activeTopics.includes(hovered)) setHovered(null)
  }

  useEffect(() => {
    if (!pinned) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (target?.closest('.chrome-condition-stack, .chrome-condition-detail')) return
      setPinned(null)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [pinned])

  const shownTopic = pinned ?? hovered

  return (
    <div className="chrome-conditions">
      {activeTopics.map((topic) => {
        const rect = rects[topic]
        if (!rect) return null
        return (
          <TopicConditions
            key={topic}
            topic={topic}
            rect={rect}
            shown={shownTopic === topic}
            onToggle={() => {
              setPinned((current) => {
                const next = current === topic ? null : topic
                // On a pointer device the cursor is still over the stack when a
                // click un-pins, so hover would re-assert immediately and the
                // click would look like it did nothing. Drop the hover with it;
                // leaving and re-entering opens it again.
                if (!next) setHovered(null)
                return next
              })
            }}
            onHover={(hovering) => setHovered(hovering ? topic : null)}
          />
        )
      })}
    </div>
  )
}
