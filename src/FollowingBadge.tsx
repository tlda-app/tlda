/**
 * FollowingBadge — shown to viewers when a presenter is active.
 * Small, unobtrusive indicator that the camera is being driven by someone else.
 */
import { useState, useEffect, useSyncExternalStore } from 'react'
import { onPresenterSignal } from './useYjsSync'
import { getRole, subscribeRole } from './viewerRole'
import './FollowingBadge.css'

export function FollowingBadge() {
  const role = useSyncExternalStore(subscribeRole, getRole)
  const [presenterActive, setPresenterActive] = useState(false)

  useEffect(() => {
    return onPresenterSignal((signal) => {
      setPresenterActive(signal.active)
    })
  }, [])

  if (role !== 'viewer' || !presenterActive) return null

  return (
    <span className="following-badge">
      Following
    </span>
  )
}
