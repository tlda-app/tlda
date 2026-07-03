import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldRenderLockedFleetViewportShape } from '../src/overlays/fleet-viewport-predicate.ts'

test('locked fleet viewport renders owned fleet panels and transient drag pills', () => {
	assert.equal(shouldRenderLockedFleetViewportShape({
		type: 'fleet-chat',
		props: { userId: 'fleet:tester', deviceId: 'device-a' },
	}, { userId: 'fleet:tester', deviceId: 'device-a' }), true)

	assert.equal(shouldRenderLockedFleetViewportShape({
		type: 'fleet-chat',
		props: { userId: 'fleet:tester', deviceId: 'device-b' },
	}, { userId: 'fleet:tester', deviceId: 'device-a' }), false)

	assert.equal(shouldRenderLockedFleetViewportShape({
		type: 'fleet-chat',
		props: { userId: 'fleet:tester', deviceId: 'device-a' },
	}, { userId: null, deviceId: 'device-a' }), false)

	assert.equal(shouldRenderLockedFleetViewportShape({
		type: 'fleet-pill',
		props: { pillType: 'agent' },
	}), true)

	assert.equal(shouldRenderLockedFleetViewportShape({
		type: 'geo',
		props: {},
	}), false)
})
