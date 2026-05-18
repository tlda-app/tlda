# DeepSeek QA Gate — Spec Draft

## Why DeepSeek

Claude agents have a completion bias: they'd rather ship bad work than admit they're stuck. When reviewing each other's work, Claude reviewers are reluctant to reject — they soften findings, suggest improvements instead of blocking, and accept "close enough." 

DeepSeek doesn't share this bias. It's more willing to say "no, this doesn't do what was asked" without hedging. That's exactly what the QA gate needs.

## Role

The DeepSeek QA agent is a **mandatory gate between math agents and Skip.** No math deliverable reaches Skip without passing through this gate. The agent's job is simple:

1. Read what Skip asked for (from the thread)
2. Read what the agent produced
3. Either approve (deliverable matches request) or reject (with specifics)

It does NOT:
- Fix the work
- Suggest improvements
- Check mathematical correctness (that's proof-reviewer's job)
- Rewrite anything

It checks ONE thing: **does the output match what was asked for?**

## Implementation Constraints

### Sandboxing (Docker)
DeepSeek agents run in Docker containers. They can:
- Read files (mounted read-only)
- Read fleet chat threads (via API)
- Send chat messages (reject/approve verdicts)
- Read the fleet DB (for thread context)

They CANNOT:
- Write to the filesystem
- Edit source files
- Restart servers
- Execute arbitrary commands
- Access the network beyond the fleet API

If the agent goes off-script, it can't do any harm — it's read-only.

### Tool Harness
Uses Goose (already available). Needs configuration for:
- Fleet chat API access (read threads, send messages)
- File read access (mounted volumes for scratch files, tex files)
- No write access anywhere

### Invocation
Triggered automatically when an agent calls `report()` or `task_done()` on a math task, OR when an agent sends a deliverable to Skip. The gate intercepts and holds the deliverable until approved.

Alternative (simpler to implement): the math agent is instructed to send deliverables to the DeepSeek QA agent instead of to Skip. QA agent forwards approved deliverables.

## The Review Protocol

### Step 1: Extract Skip's request
Read the thread. Find Skip's messages. Extract a concrete checklist:
- What content did Skip ask for?
- What structure did Skip specify?
- What did Skip say NOT to do?
- What existing text should be preserved?

### Step 2: Check the deliverable
For each item on the checklist:
- **PRESENT**: the content is in the deliverable, in the form Skip described
- **MISSING**: the content is not there
- **WRONG**: the content is there but doesn't match what Skip asked for (e.g., reformulated, weakened, rewritten when it should have been preserved)

### Step 3: Verdict
- **APPROVE**: all checklist items are PRESENT. Forward to Skip.
- **REJECT**: any item is MISSING or WRONG. Send rejection to the agent with:
  - The checklist (so the agent sees what was expected)
  - Which items failed and why
  - Skip's exact words for each failed item (so the agent can't argue with the spec)

### Step 4: On second rejection
If the agent fails twice, escalate to Skip: "Agent [X] has failed to deliver [Y] after two attempts. Here's what was asked for and what was produced." Skip decides whether to keep trying or reassign.

## What This Fixes

From the April 6 retrospective:
- **bact** produced 5 versions of the modulus section, none containing the content Skip asked for
- **paper-editor** outlined the correct approach, then delivered text that didn't include any of it
- Both agents' self-reviews checked correctness, not relevance

With the DeepSeek gate:
- bact's first draft gets rejected: "Skip asked for explanation of what delta is and where on the modulus curve the estimator operates (8:51 PM). Your text says 'determined by the approximation condition' which Skip explicitly rejected (8:46 PM, 'just shelling out to that is unacceptable')."
- paper-editor's text gets rejected: "Skip asked for 2 paragraphs covering offset complexity + subgradient term (11:34 PM). Your text rewrites the Donoho setup which already exists in the paper. The subgradient decomposition is not mentioned."

The agent either fixes it or Skip is told "they can't do it" — either way, Skip doesn't waste time reading trash.

## Implementation TODO

1. **Docker container setup** — DeepSeek base image with Goose, fleet API client, read-only mounts
2. **Goose configuration** — tools for: read_thread, read_file, chat (send only), no write tools
3. **Trigger mechanism** — hook on task_done/report for math tasks, or manual invocation
4. **Thread access** — the QA agent needs to read the full conversation thread, not a summary
5. **Testing** — run against the April 6 bact/paper-editor threads as a validation: would it have caught the failures?
