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
 * ONE PANE PER OPEN PAIR. It is created and torn down with the pair by the
 * overlay that owns both, and it holds nothing — no registry, no lifecycle of
 * its own, nothing another consumer could attach to.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import { answerDocumentSrcdoc, answerStyleSources } from './answerDocument'
import { ANSWER_DOCUMENT_CSS, ANSWER_HEADER_CLASS } from './solutionMarking'
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
  /** The answer's height in the chapter's own units, once its document has one. */
  onHeight: (height: number) => void
  /** The header the Return button portals into, once it exists. */
  onHeader: (header: HTMLElement | null) => void
  /** Whether this is the pair he is marking, which decides who wins a collision. */
  marked: boolean
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(0)

  const srcdoc = useMemo(() => {
    const styles = answerStyleSources(chapter)
    return answerDocumentSrcdoc({
      answerHtml: markup,
      // Our own chrome goes in last so it wins against the chapter's rules for
      // the header and the Return button, which are ours and not the book's.
      styles: { ...styles, inline: [...styles.inline, ANSWER_DOCUMENT_CSS] },
      baseHref: chapter.baseURI,
      // The book's theme is a class on its body — without it the callout is
      // styled by rules that never match and comes back looking like nothing.
      bodyClass: chapter.body.className,
      // And dark reading is a class on its `html`. Read here for the first
      // paint; kept in step below, because he switches it while reading.
      htmlClass: chapter.documentElement.className,
    })
  }, [markup, chapter])

  // WHAT THE PANE IS TALL IS WHAT THE ANSWER IS TALL, and that is not known
  // until its document has laid out. A student's answer is usually a
  // photograph, so it is not known at `load` either — the image arrives after
  // it. Hence an observer rather than a single measurement: the height is
  // reported whenever the answer's own document changes what it needs.
  useEffect(() => {
    const iframe = ref.current
    const view = iframe?.contentWindow
    const root = view?.document.documentElement
    if (!iframe || !view || !root) return
    const report = () => {
      onHeight(root.scrollHeight)
      onHeader(view.document.querySelector<HTMLElement>(`.${ANSWER_HEADER_CLASS}`))
    }
    report()
    // The answer's OWN `ResizeObserver`, so the observation is driven by the
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
      onHeader(null)
    }
  }, [ready, srcdoc, chapter, onHeight, onHeader])

  return (
    <iframe
      ref={ref}
      className="tlda-marking-answer-pane"
      title="Student's answer"
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
        // Under the glass, which is 200 and takes the pointer while he marks.
        // Above the book, or the answer would be behind the page it sits beside.
        //
        // AND THE ONE HE IS MARKING WINS A COLLISION. A photographed answer is
        // taller than the distance to the next solution, so panes do overlap —
        // measured up to 632px on his chapter. This does not resolve that; it
        // resolves it for the pane he is drawing on, which is the one that must
        // never be covered. Reading down a chapter of long answers is still a
        // question about what the marked region IS, and it is not a z-index.
        zIndex: marked ? 199 : 198,
      }}
    />
  )
}
