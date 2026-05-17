# Work Order: DeepSeek QA Gate (from April 6 Retrospective)

## Context

Math agents consistently fail to deliver what Skip asks for. They understand the conversation but produce text that doesn't contain the discussed content. Self-review doesn't catch this because agents frame reviews around their own concerns (correctness) rather than Skip's request (specific content).

DeepSeek is better at assertive rejection — it will say "no, this doesn't match" without the completion anxiety Claude agents have. It runs in Docker so it can't damage anything if it goes rogue.

## Architecture

```
Claude math agent finishes work
        ↓
  task_done() or sends deliverable
        ↓
  Fleet server intercepts → spawns Docker DeepSeek reviewer
        ↓
  DeepSeek reads: (1) Skip's messages from thread, (2) the deliverable
        ↓
  APPROVE → forward to Skip
  REJECT → send back to agent with specifics
  2x REJECT → escalate to Skip
```

## Implementation Tasks

### 1. Docker container for DeepSeek agents
**What:** Dockerfile that packages Goose + fleet-cli + DeepSeek provider config.
**Mounts:**
- `~/work/` → `/work/` (READ-ONLY)  
- Fleet API accessible via host networking or port forward
- `/tmp/` writable inside container (scratch space)

**Key constraint:** DeepSeek model = Docker, always. No way to spawn a DeepSeek agent outside Docker. This is enforced in the spawn system, not by convention.

**Files:** New `Dockerfile.deepseek` in fleet repo, plus a launcher script.

### 2. fleet-cli: add `get_thread` command
**What:** `fleet-cli get_thread <agent-id> [--since ISO] [--limit N]` — returns formatted conversation thread, same as the MCP `get_thread` tool.
**Why:** DeepSeek QA agent needs to read the full conversation to extract what Skip asked for. Currently fleet-cli has `chat`, `my_task`, `task_done`, `search` but not `get_thread`.
**Files:** `bin/fleet-cli` in fleet repo.

### 3. Spawn integration: deepseek = docker
**What:** When `fleet spawn` or `bin/fleet-spawn` is called with a DeepSeek model, it automatically:
1. Builds/pulls the Docker image
2. Runs the container with read-only mounts
3. Injects fleet registration, task, and SSE connection
4. No `--sandbox` flag — it's the only path

**Files:** `bin/fleet-spawn` in fleet repo, possibly `server/routes/agents.mjs` if spawn goes through the API.

### 4. QA review protocol in fleet-goose preamble
**What:** Update the preamble text that fleet-goose injects into the DeepSeek agent's initial prompt. Add the review protocol:

```
# QA Review Protocol
You are reviewing work done by another agent for Skip.

1. Read Skip's messages in the thread (use: fleet-cli get_thread <agent-id>)
2. Extract what Skip asked for — make a checklist
3. Read the deliverable the agent produced
4. For each checklist item: PRESENT, MISSING, or WRONG
5. If all PRESENT → APPROVE and forward to Skip
6. If any MISSING/WRONG → REJECT with specifics (quote Skip's words)

IMPORTANT: Ignore the agent's description of what they were asked to do.
Read Skip's actual messages. Agents consistently misrepresent the request.
```

**Files:** `bin/fleet-goose` in fleet repo.

### 5. Trigger mechanism
**What:** When a Claude math agent calls `task_done()` or sends a deliverable to Skip, the fleet server automatically spawns a DeepSeek QA review.

**Options (simplest first):**
- **A. Manual command:** `fleet-cli qa-review <agent-id>` — manager or agent calls it explicitly
- **B. Hook on task_done:** Server-side hook that spawns QA when task type is "math" or "writing"
- **C. Intercept chat to Skip:** Any agent→Skip message containing a deliverable (attachment, long text) gets held for QA

Start with A. Graduate to B when it's proven.

**Files:** `bin/fleet-cli` (new command), `server/server.mjs` (hook for B).

### 6. Validation test
**What:** Run the DeepSeek QA agent against the April 6 bact and paper-editor threads. It should reject:
- bact's modulus section drafts (missing: what delta is, where on the curve the estimator operates)
- paper-editor's text (missing: subgradient decomposition, plot reference, content discussed at 11:24-11:34 PM)

If it approves either of those, the protocol needs tuning.

## Priority Order

1 → 2 → 4 → 5A → 6 → 3 → 5B

Docker container and fleet-cli get_thread are prerequisites. The protocol and manual trigger get it usable. Validation proves it works. Spawn integration and auto-trigger come last.

## Notes

- The reviewer independence rule (scratch/retro-reviewer-independence.md) applies to Claude reviewers too — it's not DeepSeek-specific. Those additions to qa-agent.md, paper-reviewer spec, and proof-reviewer spec should be made regardless.
- This gate is for math/writing deliverables. App/infrastructure work already has the qa-haiku → qa-opus pipeline (though that's also not being enforced consistently — see April 4 W7 merge).
