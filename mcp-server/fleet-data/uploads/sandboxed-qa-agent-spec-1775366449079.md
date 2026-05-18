# Sandboxed QA Agent — Docker Spec

## Goal

Run untrusted model agents (DeepSeek via Goose, or any model) in a Docker container with read-only access to the codebase, fleet chat for communication, and playwright for testing. They can review and test but can't modify anything.

## Container Setup

### Dockerfile

```dockerfile
FROM node:20-slim

# Install goose, playwright deps, git
RUN apt-get update && apt-get install -y \
    curl git chromium \
    && rm -rf /var/lib/apt/lists/*

# Install Goose CLI
RUN curl -fsSL https://github.com/block/goose/releases/latest/download/goose-linux-x64 -o /usr/local/bin/goose \
    && chmod +x /usr/local/bin/goose

# Install playwright browsers
RUN npx playwright install chromium

WORKDIR /workspace

# QA instructions injected at runtime via mount
ENV GOOSE_MOIM_MESSAGE_FILE=/config/qa-instructions.md
```

### Volume Mounts

```bash
docker run \
  -v /Users/skip/work:/workspace:ro \          # codebase — READ ONLY
  -v /path/to/qa-instructions.md:/config/qa-instructions.md:ro \  # QA prompt
  -v /tmp/qa-screenshots:/screenshots \        # writable — screenshots only
  --network host \                             # access to localhost:5176 (tlda), 5199 (fleet), 8178 (whisper)
  --name qa-deepseek \
  sandboxed-qa
```

Key:
- `/workspace` is read-only — agent can browse code but can't modify it
- `/screenshots` is the only writable mount — for playwright evidence
- `--network host` gives access to local services (fleet dashboard, tlda server, whisper)

### QA Instructions File (`qa-instructions.md`)

```markdown
# You are a QA agent.

Your job is to verify that completed work matches its specification and actually functions correctly.

## What you can do
- Read any file in /workspace (read-only)
- Run playwright to test the app at http://localhost:5176
- Send messages via fleet chat (fleet MCP server)
- Take screenshots and save to /screenshots/

## What you cannot do
- Modify any file (filesystem is read-only)
- Push code, merge branches, or make commits
- Restart servers or rebuild bundles
- Tell the user (Skip) to test anything

## Your process
1. Read the task description and test plan
2. Open the app in playwright
3. Run through the test plan step by step
4. Take screenshots at each step
5. Report: PASS or FAIL with specific evidence
6. If FAIL: describe exactly what's broken, with reproduction steps

## How to report
Send your verdict via fleet chat to the guidance agent. Include:
- Each test plan item: PASS or FAIL
- Screenshot paths for evidence
- If FAIL: what you expected vs what happened
- Console errors if any

## Rules
- Do NOT say "it works" without evidence
- Do NOT approve work you haven't tested yourself
- Do NOT be polite about failures — be specific and direct
- If evidence is missing or weak, reject and say why
```

## Spawning

Add to `fleet-spawn`:

```bash
fleet-spawn --fresh qa-deepseek --model deepseek --sandbox docker
```

The `--sandbox docker` flag:
1. Builds the container image if not present
2. Starts the container with the mounts above
3. Runs `goose session -n qa-{task-id}` inside the container
4. Connects fleet MCP via network (host mode)

## MCP Access from Container

With `--network host`, the container can reach:
- Fleet dashboard API at `http://127.0.0.1:5199` — for fleet chat, task state
- tlda server at `http://127.0.0.1:5176` — for testing the app
- Whisper at `http://127.0.0.1:8178` — if testing voice features

Fleet MCP server runs as a stdio process normally, but for Docker we'd need either:
- An HTTP/SSE bridge (fleet already has this via the dashboard API)
- Or mount the MCP socket into the container

The dashboard API approach is simpler — the QA agent uses `curl` to fleet endpoints instead of MCP tools.

## Alternative: Goose `--container` Flag

Goose natively supports `--container <ID>` for running extensions inside Docker. This might handle the container lifecycle automatically. Worth testing before building custom Docker integration.

## What This Enables

- **Any untrusted model as QA** — DeepSeek, Gemini, open-source models. The sandbox is model-agnostic.
- **No risk of damage** — read-only filesystem, no git access, can only observe and report
- **Pushiness is a feature** — DeepSeek's tendency to push back becomes an asset in QA
- **Cheap QA at scale** — run DeepSeek QA on every task, reserve Claude for implementation
