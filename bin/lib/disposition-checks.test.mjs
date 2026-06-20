// Run: node bin/lib/disposition-checks.test.mjs
// Exercises the selective turn-end checks against a table of realistic turns.
import { runChecks } from './disposition-checks.mjs'

// [name, lastMsgToSkip, activityText, expectedLabel|null]
const CASES = [
  // FIRE — done-claim with no verification activity
  ['done, no verification', 'Fixed the layout — the sidebar is 50/50 now. Done.', 'Edit src/Foo.tsx | Bash git commit', 'untouched-surface'],
  ['shipped, only edits', "Shipped the build-card color change, it's working now.", 'Edit a.ts | Edit b.ts | Write c.ts', 'untouched-surface'],
  ['merged claim, no test', 'All set — merged to the branch and it works.', 'Bash git merge | Bash git push', 'untouched-surface'],

  // QUIET — done-claim BUT verified (screenshot / pw / test / curl)
  ['done + screenshot', 'Fixed it — done.', 'Edit Foo.tsx | mcp__tlda__screenshot bregman | Bash tlda-dev pw goto', null],
  ['done + test run', 'It works now, all set.', 'Edit est.R | Bash npm run test | Bash vitest run', null],
  ['done + curl verify', 'Deployed and confirmed working.', 'Bash curl https://localhost:5176/health | Edit server.mjs', null],

  // QUIET — not an assertive claim (negation / future)
  ['not done yet', 'Not done — still need to wire the handler.', 'Edit x.ts', null],
  ['couldnt verify', "I think it's fixed but I couldn't verify it on the surface.", 'Edit x.ts', null],
  ['when done', 'When done, I will let you know. Tracing the bug now.', 'Read a.ts', null],

  // QUIET — ordinary report / finding / question (no claim, no punt)
  ['finding', 'Found the root cause: the daemon emits agent-thinking every sweep, not on transition.', 'Read daemon.mjs', null],
  ['question', 'Should the synthetic event go in the events DB or stay a transient broadcast?', '', null],
  ['progress', 'Working through the sync handler — about halfway.', 'Read sync.mjs | Edit sync.mjs', null],

  // FIRE — punt (make him steer)
  ['punt reload', 'Pushed the change — reload and check it looks right on your end.', 'Edit ui.tsx', 'dont-make-him-steer'],
  ['punt let-me-know', 'Try it out and let me know if it works.', 'Edit ui.tsx', 'dont-make-him-steer'],

  // QUIET — loose-end report ("not deployed", "would require"). v1 does NOT fire
  // on this: regex can't tell an honest scope boundary from a punt, and todd's
  // loose-end watchdog already covers the message. Left to a future LLM-judge.
  ['loose end not-deployed', 'The fix is in but not deployed; would require a fly deploy to go live.', 'Edit server.mjs', null],
]

let pass = 0, fail = 0
for (const [name, msg, act, expected] of CASES) {
  const hit = runChecks(msg, act)
  const got = hit ? hit.label : null
  const ok = got === expected
  if (ok) pass++; else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} expected=${String(expected).padEnd(20)} got=${got}`)
}
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
