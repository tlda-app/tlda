export async function readSharedDocumentThroughOwner({ fleetStore, sendDaemonEphemeral, document }) {
  const agentId = String(document?.authorId || '')
  const filePath = String(document?.path || '')
  const route = agentId && fleetStore ? await fleetStore.getAgentDaemonRoute(agentId) : null
  if (!route) {
    const error = new Error(`shared document ${document?.id || filePath} has no owning daemon route`)
    error.code = 'NO_ROUTE'
    throw error
  }
  return sendDaemonEphemeral(route.daemon_key, 'read-document-text', {
    agent_id: agentId,
    path: filePath,
  })
}
