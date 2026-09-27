/**
 * The student's answer, rendered in the parent beside the chapter.
 *
 * The answer belongs in the margin next to a full-width solution, and the
 * margin is outside the iframe the chapter renders in — so an answer placed
 * there by the chapter is laid out correctly and clipped unreadable. This is
 * the same place, hosted by the document that has no such edge.
 *
 * It is an iframe rather than an element because the app has no `.callout`
 * rules at all: the answer looks like a callout only while it is inside a
 * Quarto document, so an element moved out here renders as a grey panel. See
 * `answerDocument.ts`, which builds the document it carries.
 *
 * ONE PANE PER OPEN PAIR, IN TWO DOCUMENTS. The handed-over answer is one
 * callout — name header first, work below it — and it renders as two stacked
 * iframes rather than one, because the header and the body need opposite
 * answers from hit-testing:
 *
 * - The header carries the marking controls (Return, the plus, Send, the
 *   Layers dropdown). It opts into pointer events, and it sits ABOVE the
 *   marking glass (z 201 over the glass's 200), so pressing a control works
 *   whatever tool is armed — with a draw tool the glass owns the pen over the
 *   whole pair, and a header beneath it would take taps as ink dots.
 * - The body is the work being read. It declines pointer events explicitly,
 *   so clicks and wheel fall through to the glass while marking and to the
 *   canvas otherwise — the pane never swallows a pan, and a wheel over a
 *   five-thousand-pixel answer moves the page exactly as it did before marking
 *   opened. That `none` is the design, not the defect recurring: the defect
 *   was the header inheriting it with no opt-in anywhere.
 *
 * The split is presentational: the handover from the chapter is still one
 * markup string, and `splitAnswerMarkup` divides it at render. If it ever
 * arrives without a header, the whole thing renders in the header frame —
 * controls first, body swallowing — rather than failing to show the work.
 *
 * It is created and torn down with the pair by the overlay that owns both,
 * and it holds nothing — no registry, no lifecycle of its own, nothing
 * another consumer could attach to.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import { answerDocumentSrcdoc, answerStyleSources } from './answerDocument'
import { ANSWER_DOCUMENT_CSS, ANSWER_HEADER_CLASS, splitAnswerMarkup } from './solutionMarking'
import './AnswerPane.css'

export function AnswerPane({
  markup,
  chapter,
  bounds,
  scale,
  onHeight,
  onHeader,
  marked,
}: {
  /** The answer, marked up for a document of its own. */
  markup: string
  /** The chapter's document, for the styling and the base the answer needs. */
  chapter: Document
  /** Where the answer goes, in screen coordinates, from the pair's ink frame. */
  bounds: { left: number; top: number; width: number; height: number }
  /** The chapter's scale, so the answer is laid out at the width it is measured at. */
  scale: number
  /** The answer's height in the chapter's own units, once its documents have one. */
  onHeight: (height: number) => void
  /** The header the controls portal into, once it exists. */
  onHeader: (header: HTMLElement | null) => void
  /** Whether this is the pair he is marking, which decides who wins a collision. */
  marked: boolean
}) {
  const [headerMarkup, bodyMarkup] = useMemo(() => splitAnswerMarkup(markup), [markup])
  const styles = useMemo(() => {
    const sources = answerStyleSources(chapter)
    // Our own chrome goes in last so it wins against the chapter's rules for
    // the header and the Return button, which are ours and not the book's.
    return { ...sources, inline: [...sources.inline, ANSWER_DOCUMENT_CSS] }
  }, [chapter, markup])
  const baseHref = chapter.baseURI
  const bodyClass = chapter.body.className
  const htmlClass = chapter.documentElement.className

  const headerSrcdoc = useMemo(() => headerMarkup === null ? null : answerDocumentSrcdoc({
    answerHtml: headerMarkup,
    styles,
    baseHref,
    bodyClass,
    htmlClass,
  }), [headerMarkup, styles, baseHref, bodyClass, htmlClass])
  const bodySrcdoc = useMemo(() => bodyMarkup === null ? null : answerDocumentSrcdoc({
    answerHtml: bodyMarkup,
    styles,
    baseHref,
    bodyClass,
    htmlClass,
  }), [bodyMarkup, styles, baseHref, bodyClass, htmlClass])

  // WHAT EACH FRAME IS TALL IS WHAT ITS DOCUMENT IS TALL, in the chapter's own
  // units, and neither is known until its document has laid out. A student's
  // answer is usually a photograph, so it is not known at `load` either — the
  // image arrives after it. Hence an observer per document rather than a
  // single measurement: the heights are reported whenever either document
  // changes what it needs, and the frame is their sum.
  const [headerHeight, setHeaderHeight] = useState(0)
  const [bodyHeight, setBodyHeight] = useState(0)
  useEffect(() => {
    onHeight(headerHeight + bodyHeight)
  }, [headerHeight, bodyHeight, onHeight])

  return (
    <>
      {headerSrcdoc !== null && (
        <AnswerFrame
          srcdoc={headerSrcdoc}
          chapter={chapter}
          title="Answer header with marking controls"
          className="tlda-marking-header-pane"
          bounds={{ ...bounds, height: headerHeight * scale }}
          scale={scale}
          zIndex={201}
          onHeight={setHeaderHeight}
          onHeader={onHeader}
        />
      )}
      {bodySrcdoc !== null && (
        <AnswerFrame
          srcdoc={bodySrcdoc}
          chapter={chapter}
          title="Student's answer"
          className="tlda-marking-body-pane"
          bounds={{ ...bounds, top: bounds.top + headerHeight * scale, height: bodyHeight * scale }}
          scale={scale}
          // Under the glass, which is 200 and takes the pointer while he marks.
          // Above the book, or the answer would be behind the page it sits beside.
          //
          // AND THE ONE HE IS MARKING WINS A COLLISION. A photographed answer is
          // taller than the distance to the next solution, so panes do overlap —
          // measured up to 632px on his chapter. This does not resolve that; it
          // resolves it for the pane he is drawing on, which is the one that must
          // never be covered. Reading down a chapter of long answers is still a
          // question about what the marked region IS, and it is not a z-index.
          zIndex={marked ? 199 : 198}
          onHeight={setBodyHeight}
          onHeader={null}
        />
      )}
    </>
  )
}

function AnswerFrame({
  srcdoc,
  chapter,
  title,
  className,
  bounds,
  scale,
  zIndex,
  onHeight,
  onHeader,
}: {
  srcdoc: string
  chapter: Document
  title: string
  className: string
  bounds: { left: number; top: number; width: number; height: number }
  scale: number
  zIndex: number
  onHeight: (height: number) => void
  /** Reports the header element, for the frame that carries it; null for the body. */
  onHeader: ((header: HTMLElement | null) => void) | null
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(0)

  useEffect(() => {
    const iframe = ref.current
    const view = iframe?.contentWindow
    const root = view?.document.documentElement
    if (!iframe || !view || !root) return
    const report = () => {
      onHeight(root.scrollHeight)
      if (onHeader) onHeader(view.document.querySelector<HTMLElement>(`.${ANSWER_HEADER_CLASS}`))
    }
    report()
    // The frame's OWN `ResizeObserver`, so the observation is driven by the
    // document being measured rather than by ours. `contentWindow` is typed as
    // `Window`, which does not declare it — the global constructors live on
    // `typeof globalThis` — so the view is named at the type it actually has.
    const resize = new (view as Window & typeof globalThis).ResizeObserver(report)
    resize.observe(root)

    // FOLLOW THE CHAPTER INTO DARK AND BACK.
    //
    // `HtmlPageShape` toggles `tlda-dark` on each document it renders when he
    // changes theme. The answer is a document too and nothing tells it, so
    // without this it keeps whichever theme it was built in — an un-inverted
    // answer beside an inverted chapter, which is the dim pane. Copied rather
    // than rebuilt into the srcdoc, because rebuilding reloads the iframe and
    // he would lose his place in a long answer to a theme switch.
    const follow = () => { root.className = chapter.documentElement.className }
    follow()
    const theme = new MutationObserver(follow)
    theme.observe(chapter.documentElement, { attributes: true, attributeFilter: ['class'] })

    return () => {
      resize.disconnect()
      theme.disconnect()
      if (onHeader) onHeader(null)
    }
  }, [ready, srcdoc, chapter, onHeight, onHeader])

  return (
    <iframe
      ref={ref}
      className={className}
      title={title}
      srcDoc={srcdoc}
      onLoad={() => setReady(current => current + 1)}
      style={{
        position: 'fixed',
        left: bounds.left,
        top: bounds.top,
        // Laid out at the chapter's own width and then scaled, rather than
        // sized in screen pixels: the height measured inside is then in the
        // chapter's units, which is what the ink frame is expecting, and
        // zooming the book cannot reflow the answer underneath the marks.
        width: scale > 0 ? bounds.width / scale : bounds.width,
        height: scale > 0 ? bounds.height / scale : bounds.height,
        transform: `scale(${scale})`,
        transformOrigin: '0 0',
        border: 'none',
        background: 'transparent',
        zIndex,
      }}
    />
  )
}
