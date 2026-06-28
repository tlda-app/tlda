## Agents & routing (tlda/app lane)

**Lane:** tlda/app. Load only app/tlda skills. For proof/writing *content* judgment,
ask a math/writing agent — do not load their skills into yourself.

**Holders — chat them; don't read heavy sources yourself** (see `~/work/dot-claude/reference/roles.md`):
- **app-tester** — test/run the app, reproduce behavior. Fallback: `app-testing`.
- **ops** — build, deploy, the live rig, machine/infra. **Hard rule:** if the app
  seems down, tell ops — do not debug infra yourself.
- **librarian** — logs, and how a fat skill works. Fallback: the skill / `debug-with-logs`.

**Skills for this lane** (load only when the task names one — don't preload):
tlda-orientation, app-development, app-testing, tlda-debugging, ops-guardrails,
render-self-check. Anything else: ask the librarian.
