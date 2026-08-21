#!/usr/bin/env node
import { validateProposalUpdates } from '../server/lib/git-proposals.mjs'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = Buffer.concat(chunks).toString('utf8')
const mode = process.argv[2]

try {
  if (mode === 'pre-receive') {
    await validateProposalUpdates({
      gitDir: process.env.GIT_DIR,
      project: process.env.TLDA_GIT_PROJECT,
      daemonId: process.env.TLDA_GIT_DAEMON_ID,
      input,
    })
  } else if (mode === 'post-receive') {
    for (const line of input.trim().split('\n').filter(Boolean)) {
      const [, revision] = line.trim().split(/\s+/)
      process.stdout.write(`SubmittedToBuildQueue ${revision}\n`)
    }
  } else {
    throw new Error(`unknown proposal hook mode: ${mode}`)
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
