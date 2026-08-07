export async function scheduleSubscriptionWakes({
  deliveries,
  eventId,
  text,
  from,
  traceId,
  priority,
  wakeRequests,
  wakeText,
  agentDisplayName,
  previewForWake,
  queueBatchWake,
}) {
  for (const delivery of deliveries) {
    if (delivery.delivery === 'notified') {
      wakeRequests.push({
        to: delivery.recipient,
        text: wakeText({ what: `a message from ${await agentDisplayName(from)}`, preview: previewForWake(text) }),
        asker: from,
        traceId,
        source: { sourceEventId: eventId, priority, subscriptionId: delivery.subscription_id },
      })
    } else if (delivery.delivery === 'batched' && delivery.notifyBy) {
      queueBatchWake({ delivery, eventId, text, from, traceId, priority })
    }
  }
}
