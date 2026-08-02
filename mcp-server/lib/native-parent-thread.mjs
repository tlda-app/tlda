export function matchesLocalParentThread(threadId, claudeSession, mintSessionId) {
  return Boolean(threadId && (threadId === claudeSession || threadId === mintSessionId))
}
