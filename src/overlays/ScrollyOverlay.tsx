/**
 * Scrollytelling overlay — two modes:
 * 1. Immersive (auto on scroll, or click a step in iframe): frosted full-viewport
 * 2. Dismissed: no overlay, figures visible in document, click step text to reopen
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { react } from 'tldraw'
import type { Editor } from 'tldraw'
import { htmlScrollyRegions, type ScrollyRegion } from '../shapes/HtmlPageShape'
import './ScrollyOverlay.css'

interface ScrollyOverlayProps {
  mainEditor: Editor
}

export function ScrollyOverlay({ mainEditor }: ScrollyOverlayProps) {
  const [activeRegion, setActiveRegion] = useState<ScrollyRegion | null>(null)
  const [activeStep, setActiveStep] = useState(0)
  const [visible, setVisible] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const activeRegionRef = useRef<string | null>(null)
  const activeStepRef = useRef(0)
  const dismissedRegionRef = useRef<string | null>(null)

  useEffect(() => {
    const stop = react('scrolly-overlay', () => {
      const cam = mainEditor.getCamera()
      const vb = mainEditor.getViewportScreenBounds()
      const viewportCenterY = -cam.y + (vb.y + vb.h / 2) / cam.z

      const shapes = mainEditor.getCurrentPageShapes()
      const htmlShape = shapes.find((s: any) => s.type === 'html-page') as any
      if (!htmlShape) {
        if (activeRegionRef.current) {
          activeRegionRef.current = null
          setActiveRegion(null)
          setVisible(false)
          setDismissed(false)
        }
        return
      }

      const regions = htmlScrollyRegions.get(htmlShape.id)
      if (!regions || regions.length === 0) {
        if (activeRegionRef.current) {
          activeRegionRef.current = null
          setActiveRegion(null)
          setVisible(false)
          setDismissed(false)
        }
        return
      }

      const contentY = viewportCenterY - htmlShape.y

      let foundRegion: ScrollyRegion | null = null
      for (const region of regions) {
        if (contentY >= region.startY && contentY <= region.endY) {
          foundRegion = region
          break
        }
      }

      if (!foundRegion) {
        if (activeRegionRef.current) {
          activeRegionRef.current = null
          setActiveRegion(null)
          setVisible(false)
          setDismissed(false)
        }
        return
      }

      let stepIdx = 0
      for (let i = 0; i < foundRegion.steps.length; i++) {
        if (foundRegion.steps[i].y <= contentY) {
          stepIdx = i
        }
      }

      const regionChanged = foundRegion.id !== activeRegionRef.current
      const stepChanged = stepIdx !== activeStepRef.current

      if (regionChanged) {
        activeRegionRef.current = foundRegion.id
        activeStepRef.current = stepIdx
        setActiveRegion(foundRegion)
        setActiveStep(stepIdx)
        setVisible(true)
        if (foundRegion.id !== dismissedRegionRef.current) {
          setDismissed(false)
          dismissedRegionRef.current = null
        }
      } else if (stepChanged) {
        activeStepRef.current = stepIdx
        setActiveStep(stepIdx)
      }
    })
    return stop
  }, [mainEditor])

  const handleDismiss = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    setDismissed(true)
    dismissedRegionRef.current = activeRegionRef.current
  }, [])

  // Crossfade: briefly fade out on image change
  const imgRef = useRef<HTMLImageElement>(null)
  const prevImgUrl = useRef<string | null>(null)
  useEffect(() => {
    if (!activeRegion || !visible || dismissed) return
    const step = activeRegion.steps[activeStep]
    if (!step?.imageUrl || step.imageUrl === prevImgUrl.current) return
    const img = imgRef.current
    if (img && prevImgUrl.current !== null) {
      img.setAttribute('data-fading', '')
      requestAnimationFrame(() => {
        setTimeout(() => img.removeAttribute('data-fading'), 30)
      })
    }
    prevImgUrl.current = step.imageUrl
  }, [activeRegion, activeStep, visible, dismissed])

  if (!activeRegion || !visible || dismissed) return null

  const step = activeRegion.steps[activeStep]
  if (!step?.imageUrl) return null

  return (
    <div className="scrolly-backdrop">
      <div className="scrolly-figure-wrap">
        <img
          ref={imgRef}
          className="scrolly-figure"
          src={step.imageUrl}
          alt={step.label}
          key={step.imageUrl}
        />
      </div>
      {(step.label || step.text) && (
        <div className="scrolly-text">
          <span className="scrolly-label">{step.label}</span>
          <span className="scrolly-step-counter">
            {activeStep + 1}/{activeRegion.steps.length}
          </span>
          {step.text && <p>{step.text}</p>}
        </div>
      )}
      <button
        className="scrolly-close"
        onPointerDown={handleDismiss}
        title="Dismiss"
      >
        &times;
      </button>
    </div>
  )
}
