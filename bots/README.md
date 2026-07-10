# tlda Managed Bots

This directory is the internal module boundary for fleet bots shipped from this
repo. Executable compatibility wrappers live in `bin/bots/`; bot implementation
belongs here.

## Boundaries

- `todd.mjs` plus `todd/`: Todd-specific behavior, including Todd disclosure
  classifier/eval tooling. Todd is Skip's bot/product, not generic tlda
  infrastructure. Keep Todd code easy to extract into a separately distributed
  bot.
- `disposition.mjs` plus `self-check/`: generic turn-end self-check behavior.
  Todd can reuse this behavior, but it is not Todd-specific unless a future
  extraction intentionally makes it so.
- `dev/`: developer-machine automation that is not part of the reading/math
  product. `dev/reaper.mjs` owns process reaping and markdown report generation;
  the daemon only wires it to machine-local process access and RPC/status relay.

Do not use this directory as a dumping ground for all CLI tools. Math/operator
tools such as repo-doctor are not app-developer tools and are not bots merely
because agents may use them.
