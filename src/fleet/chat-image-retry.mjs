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

function scheduleRetry(img, opts = {}) {
  if (!isRetryableChatImage(img)) return false
  if (img.dataset.chatImageRetryPending === '1') return false
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const attempt = Number(img.dataset.chatImageRetryCount || '0') + 1
  if (attempt > maxRetries) return false

  img.dataset.chatImageRetryCount = String(attempt)
  img.dataset.chatImageRetryPending = '1'
  const failedSrc = img.currentSrc || img.src || img.getAttribute('src') || ''
  img.dataset.chatImageRetrySrc = failedSrc

  globalThis.setTimeout(() => {
    delete img.dataset.chatImageRetryPending
    if (!img.isConnected) return
    const current = img.currentSrc || img.src || img.getAttribute('src') || ''
    if (img.dataset.chatImageRetrySrc !== failedSrc) return
    img.src = retryImageUrl(failedSrc, attempt, opts.baseHref)
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
