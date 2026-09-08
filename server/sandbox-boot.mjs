#!/usr/bin/env node
/**
 * Sandbox preview entrypoint.
 *
 * `tlda-dev serve --sandbox` launches this instead of `server/unified-server.mjs`
 * so that the interval between "the OS has a pid" and "the server module starts
 * running its body" is observable: everything unified-server imports is
 * evaluated before its first line of output, so a boot that stalls in that
 * graph is indistinguishable, in a retained log, from one that never started.
 *
 * It adds no behavior of its own — it marks, then imports the unchanged server.
 * Every other launch path still runs unified-server.mjs directly.
 */
import { bootWithStartupTrace } from '../shared/startup-trace.mjs'

await bootWithStartupTrace(() => import('./unified-server.mjs'), 'server/unified-server.mjs')
