# `tlda deploy` Command Report

**Branch:** `worktree-deploy-cmd` | **Commit:** `72fa55c`
**File changed:** `cli/tlda.mjs` (+102 lines)

---

## What it does

One command to build, restart, and verify:

```
$ tlda deploy

tlda deploy

  Building SPA (npm run build)... ✓
  Verifying dist/index.html... ✓ 1KB
  Stopping server... ✓
  Starting server... ✓
  Waiting for server... ✓ http://localhost:5176
  Verifying SPA serves pages... ✓
  Verifying doc page loads... ✓ (no projects to test)

Deploy complete.
```

## Steps

| Step | What it does | Failure mode |
|------|-------------|--------------|
| 1. Build | `npm run build` (180s timeout) | Build errors → stops |
| 2. Verify bundle | Check `dist/index.html` exists, >100 bytes | Missing/empty → stops |
| 3. Stop server | `tlda server stop` (tolerates already-stopped) | — |
| 4. Start server | `tlda server start` | Fails to start → stops |
| 5. Wait for ready | Poll `/health` every 500ms, 10s timeout | Timeout → stops |
| 6. Verify SPA | Fetch `/` with auth token, check `<div id="root">` | Missing root → stops |
| 7. Verify doc | Load first project's doc page | API error → stops |

Any failure stops the pipeline with `✗` and a clear error message.

## Usage

```bash
tlda deploy          # build + restart + verify
```

No flags needed. Auth token auto-loaded from config.
