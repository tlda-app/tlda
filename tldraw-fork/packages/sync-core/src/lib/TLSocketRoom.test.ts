import assert from 'node:assert/strict'
import test from 'node:test'
import { RoomSessionState } from './RoomSession'
import type { WebSocketMinimal } from './ServerSocketAdapter'
import { TLSocketRoom } from './TLSocketRoom'

class FakeSocket extends EventTarget {
	readyState = 1
	closeCalls = 0
	private capturedListeners = new Map<string, EventListener>()

	override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null) {
		if (typeof callback === 'function') this.capturedListeners.set(type, callback)
		super.addEventListener(type, callback)
	}

	send() {}

	close() {
		this.closeCalls++
		this.readyState = 2
	}

	dispatchCaptured(type: string, event: Event) {
		this.capturedListeners.get(type)?.(event)
	}
}

test('a replaced socket cannot affect the replacement session', () => {
	const receivedMessages: unknown[] = []
	const room = new TLSocketRoom({
		onAfterReceiveMessage: ({ message }) => receivedMessages.push(message),
	})
	const oldSocket = new FakeSocket()
	const replacementSocket = new FakeSocket()

	room.handleSocketConnect({
		sessionId: 'same-session',
		socket: oldSocket as unknown as WebSocketMinimal,
	})
	room.handleSocketConnect({
		sessionId: 'same-session',
		socket: replacementSocket as unknown as WebSocketMinimal,
	})

	oldSocket.dispatchCaptured(
		'message',
		new MessageEvent('message', { data: JSON.stringify({ type: 'ping' }) })
	)
	oldSocket.dispatchEvent(new Event('error'))
	oldSocket.dispatchEvent(new Event('close'))

	assert.equal(room.sessions.get('same-session')?.socket, replacementSocket)
	assert.equal(room.room.sessions.get('same-session')?.state, RoomSessionState.AwaitingConnectMessage)
	assert.equal(replacementSocket.closeCalls, 0)
	assert.deepEqual(receivedMessages, [])

	replacementSocket.dispatchEvent(
		new MessageEvent('message', { data: JSON.stringify({ type: 'ping' }) })
	)

	assert.deepEqual(receivedMessages, [{ type: 'ping' }])

	replacementSocket.dispatchEvent(new Event('close'))

	assert.equal(room.room.sessions.get('same-session')?.state, RoomSessionState.AwaitingRemoval)
	assert.equal(replacementSocket.closeCalls, 1)
	room.close()
})
