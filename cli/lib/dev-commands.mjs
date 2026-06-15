/**
 * Single source of truth for which CLI commands are *developer* commands —
 * i.e. only used when hacking on tlda itself, not in day-to-day review/authoring.
 *
 * These live under the separate `tlda-dev` script (the developer app) and are
 * kept OUT of plain `tlda` (the user app): `tlda --help` never lists them, and
 * `tlda <devcmd>` is refused with a pointer to `tlda-dev <devcmd>`.
 *
 * Re-sorting a command between user-facing and developer is a one-line edit here.
 */

export const DEV_COMMANDS = ['pw', 'worktree', 'sandbox', 'dev-url', 'deploy', 'restart-mcp']

export const DEV_HELP = `tlda-dev — developer commands for hacking on tlda itself

Three dev-environment modes (the user app is just \`tlda server start\`):
  worktree <branch> [--port N]  Worktree Vite dev server — free port, https,
                     off .worktrees/<branch> (creates it if missing). Chat/fleet
                     resolves to your global store (Fly) via /api/fleet-config;
                     docs + shapes stay on your local server. Your room, your code.
  sandbox [start|stop|status]   Fully isolated test server — own DB + projects +
                     port, no supervisors, not on the global store — to test new
                     shapes without touching a live room.

Other commands:
  pw <verb> [args]   Drive the one shared playwright browser (goto, click,
                     screenshot, snapshot, eval, …); acquire/release/status/reap
  dev-url            Print the worktree dev server URL (reads .dev-url)
  deploy             Build, restart the server, verify the SPA renders
  restart-mcp [name…]  Reload an agent's fleet MCP (drives /mcp → Reconnect).
                     No args = your own; names = those agents; --all [--except …].
                     Only needed when developing the MCP server itself.

These live only under \`tlda-dev\` (the developer app) — not in the user-facing \`tlda\`.`
