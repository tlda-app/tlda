const RETRY_PARAM = 'chat_img_retry'
const DEFAULT_MAX_RETRIES = 6
const DEFAULT_BASE_DELAY_MS = 250

function retryDelay(attempt, baseDelayMs) {
  return Math.min(4000, baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)))
}

export function isRetryableChatImage(img) {
  if (!img || !img.classList?.contains('chat-image')) return false
  const src = img.currentSrc || img.getAttribute('src') || ''
  return /\/api\/(?:file\?|files\/)/.test(src)
}

export function retryImageUrl(src, attempt, baseHref) {
  const url = new URL(src, baseHref || globalThis.location?.href || 'http://localhost/')
  url.searchParams.set(RETRY_PARAM, `${attempt}-${Date.now()}`)
  return url.href
}

// When every retry has failed (e.g. the upload landed as a zero-byte file that
// will never decode), leave a quiet terminal state instead of a raw broken-image
// icon that keeps flapping and reserves image-sized space. Reuses the existing
// .att-upload-failed style so it reads like the pre-send upload-failed chip.
export function markChatImageUnavailable(img) {
  if (!img || img.dataset.chatImageUnavailable === '1') return false
  const doc = img.ownerDocument
  if (!doc || !img.parentNode) return false
  const name = img.getAttribute('alt') || ''
  const span = doc.createElement('span')
  span.className = 'att-upload-failed chat-image-unavailable'
  span.dataset.chatImageUnavailable = '1'
  span.title = name ? `Image unavailable: ${name}` : 'Image unavailable'
  span.textContent = name ? `${name} (image unavailable)` : 'image unavailable'
  img.parentNode.replaceChild(span, img)
  return true
}

function scheduleRetry(img, opts = {}) {
  if (!isRetryableChatImage(img)) return false
  if (img.dataset.chatImageRetryPending === '1') return false
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const attempt = Number(img.dataset.chatImageRetryCount || '0') + 1
  if (attempt > maxRetries) {
    // Retries exhausted — stop the broken→blank→broken flapping and settle on a
    // quiet "image unavailable" marker.
    markChatImageUnavailable(img)
    return false
  }

  img.dataset.chatImageRetryCount = String(attempt)
  img.dataset.chatImageRetryPending = '1'
  const failedSrc = img.currentSrc || img.src || img.getAttribute('src') || ''
  img.dataset.chatImageRetrySrc = failedSrc

  globalThis.setTimeout(() => {
    delete img.dataset.chatImageRetryPending
    if (!img.isConnected) return
    if (img.dataset.chatImageRetrySrc !== failedSrc) return
    const nextSrc = retryImageUrl(failedSrc, attempt, opts.baseHref)

    // Load the candidate on a detached image first, and only put it on the
    // visible element once it has actually decoded. Assigning img.src directly
    // clears the element while the request is in flight, so every attempt made
    // the picture go broken -> blank -> broken. Retrying is meant to be
    // invisible: while we retry, the reader keeps seeing one unchanging
    // broken-link state, and the picture appears only when there is a picture
    // to show.
    const probe = img.ownerDocument?.createElement('img')
    if (!probe) {
      if (img.style?.display === 'none') img.style.display = ''
      img.src = nextSrc
      return
    }
    const stillOurs = () => img.isConnected && img.dataset.chatImageRetrySrc === failedSrc
    probe.onload = () => {
      if (!stillOurs()) return
      if (img.style?.display === 'none') img.style.display = ''
      img.src = nextSrc
    }
    probe.onerror = () => {
      if (!stillOurs()) return
      scheduleRetry(img, opts)
    }
    probe.src = nextSrc
  }, retryDelay(attempt, baseDelayMs))
  return true
}

function scanBrokenImages(root, opts) {
  const images = root.querySelectorAll?.('img.chat-image') || []
  for (const img of images) {
    if (img.complete && img.naturalWidth === 0) scheduleRetry(img, opts)
  }
}

export function installChatImageRetry(root, opts = {}) {
  if (!root) return () => {}

  const onError = (event) => {
    const img = event.target
    if (img instanceof HTMLImageElement) scheduleRetry(img, opts)
  }
  const onLoad = (event) => {
    const img = event.target
    if (!(img instanceof HTMLImageElement)) return
    delete img.dataset.chatImageRetryCount
    delete img.dataset.chatImageRetryPending
    delete img.dataset.chatImageRetrySrc
    if (img.style?.display === 'none') img.style.display = ''
  }

  root.addEventListener('error', onError, true)
  root.addEventListener('load', onLoad, true)

  const observer = new MutationObserver(() => scanBrokenImages(root, opts))
  observer.observe(root, { childList: true, subtree: true })
  globalThis.setTimeout(() => scanBrokenImages(root, opts), 0)

  return () => {
    root.removeEventListener('error', onError, true)
    root.removeEventListener('load', onLoad, true)
    observer.disconnect()
  }
}
