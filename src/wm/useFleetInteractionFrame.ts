/**
 * The frame a fleet panel's gestures happen in, for a React consumer.
 *
 * Every fleet panel used to build this itself from a bare viewport id —
 * `useMemo(() => fleetInteractionFrame(viewportId), [viewportId])`, in four
 * places. That is four independent answers to "which layer am I on", none of
 * which asked the window manager, which is the disagreement A7 names. This is
 * the one derivation: `useCurrentLayer` resolves it, and the frame carries the
 * resolution to whatever the gesture does next.
 */

import { useMemo } from 'react'
import { useVisibilityViewportId } from '../shapes/useIsInViewport'
import { useCurrentLayer } from './useCurrentLayer'
import type { FleetInteractionFrame } from './fleet-interaction-frame'

export function useFleetInteractionFrame(): FleetInteractionFrame {
  const viewportId = useVisibilityViewportId()
  const resolution = useCurrentLayer()
  return useMemo(
    () => ({ viewportId, resolution, layerId: resolution.layerId }),
    [viewportId, resolution],
  )
}
