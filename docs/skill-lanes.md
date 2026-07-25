# Skill and lane configuration

This page records the mechanism present in the current checkout. It deliberately
does not describe proposed lane directories or catalogs as shipped behavior.

## Canonical skills today

The canonical authored skill tree is `/Users/skip/work/dot-claude/skills/`.
Each skill is a directory containing `SKILL.md`. Codex receives a curated copy
under `/Users/skip/work/dot-claude/codex/skills/` from
`dot-claude/bin/sync-codex-skills.sh`.

That script currently uses a hard-coded `CODEX_SKILLS` allowlist. It copies the
selected skills rather than symlinking the whole tree, then links
`${CODEX_HOME:-~/.codex}/skills` and `~/.agents/skills` to the curated copy.
Setting `CODEX_HOME` therefore selects which Codex state root receives the skill
link for that process.

tlda also contains `bin/sync-codex-skills.sh`, an older/different installer that
symlinks a small hard-coded `CORE` list into `$CODEX_HOME/skills` and writes an
on-demand `$CODEX_HOME/skill-index.md`. Do not treat these two scripts as one
catalog pipeline; choose the dot-claude script when maintaining the current
curated Codex copy.

## Project lanes today

Project-to-lane routing is recorded in
`/Users/skip/work/dot-claude/reference/project-lanes.json`. The lane reference
files are `lane-math.md`, `lane-app.md`, `lane-ops.md`, and `lane-guidance.md`.
In tlda, `.CLAUDE.md` includes the app-lane reference and `bin/gen-agents.mjs`
expands those includes into `AGENTS.md`.

> **Unfinished change in flight (noted 2026-07-25).** There is an uncommitted
> consolidation sitting in the shared `~/work/tlda` checkout that **deletes
> `.CLAUDE.md`, `bin/gen-agents.mjs`, and `reference/lane-app.md`** and inlines
> the guidance directly into `AGENTS.md` (`+14 / -242`). If that lands, the
> paragraph above is wrong — there is no generator and no include to expand.
>
> It is incomplete: this file was never updated, and the work had been sitting
> uncommitted and untouched for over five hours when it blocked a live deploy.
> Whoever owns it should either finish it — including this paragraph — or drop
> it, rather than leaving it parked in a shared tree where the next deploy has
> to stash it and every reader here gets a stale mechanism.

Lane routing decides which guidance a project receives. It does not currently
select a generated per-lane skill directory.

## Requested catalog/lane mechanism is not present

As of this pass, the checked filesystem contains no `skills/catalog.json`, no
`.math-claude` directory, no `.app-claude` directory, and no generator that
materializes lane-specific skill folders from a catalog. Those names may
describe the intended next organization, but presenting them as current would
be inaccurate.

When that mechanism lands, update this page from its real generator and catalog:
document the catalog schema, generated-output ownership, regeneration command,
per-process `CODEX_HOME` selection, and a check proving generated lane folders
match the catalog. Until then, the authored tree, hard-coded curated allowlist,
project-lane JSON, and AGENTS include generator are the executable sources.
