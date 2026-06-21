// Registers the fake-@deepgram/sdk resolution hooks (see deepgram-fake-hooks.mjs).
import { register } from 'node:module'
register('./deepgram-fake-hooks.mjs', import.meta.url)
