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

export const DEV_COMMANDS = ['pw', 'serve', 'dev-url', 'deploy', 'restart-mcp']

export const DEV_HELP = `tlda-dev — developer commands for hacking on tlda itself

\`tlda-dev\` is plain \`tlda\` run against the CURRENT worktree's branch + correct
injected config, plus a few dev-only verbs. Read-only mirrors (doc status, …)
forward to \`tlda\`. Raw \`server\`/\`daemon\` lifecycle is DISABLED here — a worktree
daemon could target the real fleet; use \`serve\` instead.

  serve [start] [--sandbox] [--project NAME] [--port N] [--no-build]
                     The ONE dev bring-up command. Stands up THIS worktree's branch
                     as a preview, REACHABLE from your other devices (Tailscale
                     MagicDNS host, valid cert), SPA config pointed at that host,
                     and NO token (a non-standard port disables auth). Delegates to
                     the real robust \`tlda server start\` detach, so it survives the
                     launching agent exiting. Isolated (own projects/DB/chat).
                     \`--sandbox\` also brings up a fleet-daemon wired ONLY to this
                     sandbox server (it literally cannot reach prod). Prints the
                     clean URL + a QR. \`serve stop|status|status --all|url|reap-orphans\`
                     to manage it. \`serve --help\` prints command help without
                     starting a preview. Positional branch names are refused because
                     serve is worktree-relative.
  share [--project NAME] Print the reachable, tokenless URL + QR for this worktree's
                     running preview (mirror of \`tlda project share\`, per-worktree).

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
