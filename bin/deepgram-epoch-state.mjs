export function canEnqueueEpochPcm(pcmBytes, frameBytes, maxBytes) {
  return pcmBytes + frameBytes <= maxBytes
}

export function acceptsSpeechEpoch(activeEpoch, nextEpoch) {
  return Number.isSafeInteger(nextEpoch) && nextEpoch >= 0 && (activeEpoch === null || nextEpoch > activeEpoch)
}

export function createEpochTransition(epoch, attemptId = 0) {
  return { epoch, attemptId, state: 'connecting', pcmQueue: [], pcmBytes: 0, lossEmitted: false }
}

export function enqueueEpochPcm(transition, frame, maxBytes) {
  if (transition.state !== 'connecting' || !canEnqueueEpochPcm(transition.pcmBytes, frame.length, maxBytes)) return false
  transition.pcmQueue.push(frame)
  transition.pcmBytes += frame.length
  return true
}

export function attemptOwnsTransition(transition, epoch, attemptId) {
  return transition?.state === 'connecting' && transition?.epoch === epoch && transition?.attemptId === attemptId
}

export function drainEpochPcm(transition, send) {
  let sentCount = 0
  while (sentCount < transition.pcmQueue.length) {
    if (!send(transition.pcmQueue[sentCount])) {
      transition.pcmQueue = transition.pcmQueue.slice(sentCount)
      transition.pcmBytes = transition.pcmQueue.reduce((total, frame) => total + frame.length, 0)
      return false
    }
    sentCount++
  }
  transition.pcmQueue.length = 0
  transition.pcmBytes = 0
  transition.state = 'ready'
  return true
}

export function readyEpochTransition(transition, epoch, attemptId, send) {
  if (!attemptOwnsTransition(transition, epoch, attemptId)) return 'stale'
  return drainEpochPcm(transition, send) ? 'ready' : 'failed'
}
