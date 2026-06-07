/**
 * Single source of truth for which CLI commands are *developer* commands —
 * i.e. only used when hacking on tlda itself, not in day-to-day review/authoring.
 *
 * These live under the separate `tlda-dev` script and are kept OUT of plain
 * `tlda --help` so the reviewer-facing command list stays navigable. Top-level
 * aliases still work (temporarily) so nothing breaks.
 *
 * Re-sorting a command between user-facing and developer is a one-line edit here.
 */

export const DEV_COMMANDS = ['pw', 'dev', 'dev-url', 'deploy']

export const DEV_HELP = `tlda-dev — developer commands for hacking on tlda itself

Commands:
  pw <verb> [args]   Drive the one shared playwright browser (goto, click,
                     screenshot, snapshot, eval, …); acquire/release/status/reap
  dev                Start a worktree Vite dev server (auto-picks a port)
  dev-url            Print the worktree dev server URL
  deploy             Build, restart the server, verify the SPA renders

These are also reachable as bare \`tlda <cmd>\` for now (back-compat aliases),
but \`tlda-dev <cmd>\` is the canonical form and keeps \`tlda --help\` clean.`
