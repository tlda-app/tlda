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

export const DEV_COMMANDS = ['pw', 'serve', 'sandbox', 'dev-url', 'deploy', 'restart-mcp']

export const DEV_HELP = `tlda-dev — developer commands for hacking on tlda itself

Two dev-environment modes (the user app is just \`tlda server start\`):
  serve <branch> [--port N]   Vite dev server for a branch — free port, HTTP on
                     all interfaces, off .worktrees/<branch> (creates it if
                     missing). Prints/stores a Tailscale URL when available so
                     Skip can open it from another machine; otherwise says why
                     no shareable URL is available instead of forwarding
                     localhost. Chat/fleet resolves to your global store via
                     /api/fleet-config; docs + shapes stay on your local server.
  sandbox <branch>            A complete throwaway environment for a branch — its
                     own backend + DB + projects + chat + a Vite pointed at it,
                     nothing shared. For server/shape changes that would crash a
                     live room. (\`sandbox stop|status|url\` to manage it; add
                     \`--json\` or \`--print-json\` for machine-readable rig info.)

Other commands:
  pw <verb> [args]   Drive the one shared playwright browser (goto, click,
                     screenshot, snapshot, eval, …); acquire/release/status/reap
  dev-url            Print the shareable worktree dev server URL (reads .dev-url,
                     or derives a Tailscale URL for --port). Never prints
                     localhost as a share URL.
  deploy             Build, restart the server, verify the SPA renders
  restart-mcp [name…]  Reload an agent's fleet MCP (drives /mcp → Reconnect).
                     No args = your own; names = those agents; --all [--except …].
                     Only needed when developing the MCP server itself.

These live only under \`tlda-dev\` (the developer app) — not in the user-facing \`tlda\`.`
