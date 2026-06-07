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

export const DEV_COMMANDS = ['pw', 'dev', 'dev-url', 'deploy', 'restart-mcp']

export const DEV_HELP = `tlda-dev — developer commands for hacking on tlda itself

Commands:
  pw <verb> [args]   Drive the one shared playwright browser (goto, click,
                     screenshot, snapshot, eval, …); acquire/release/status/reap
  server [start|stop|status]  Isolated test server — own DB + projects + port,
                     no supervisors — to test new shapes without a prod deploy
  dev                Start a worktree Vite dev server (auto-picks a port)
  dev-url            Print the worktree dev server URL
  deploy             Build, restart the server, verify the SPA renders
  restart-mcp [name…]  Reload an agent's fleet MCP (drives /mcp → Reconnect).
                     No args = your own; names = those agents; --all [--except …].
                     Only needed when developing the MCP server itself.

These live only under \`tlda-dev\` — they're not in the reviewer-facing \`tlda\`.`
