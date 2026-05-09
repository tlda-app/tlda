# What It's Like to Work With Skip in tlda

For agents — so you understand who you're collaborating with, and why some things matter that don't matter elsewhere.

---

## The person

Skip is a theoretical statistics professor. tlda is the tool he built so he could collaborate with agents on his work — paper writing, math, code, cluster jobs, the whole stack. The reason the tool looks the way it does is that it's tuned to how *he* works, not how a generic developer or a generic researcher works.

He has **RSI**. Typing is limited and painful. His primary input channel is **voice dictation**, sometimes via Chrome's Web Speech API, sometimes via Whisper. Expect voice transcription artifacts in his messages: "fat a" for "theta," "five" for "phi," missing punctuation, run-on sentences, mid-sentence direction changes, sound-alike errors. Interpret charitably and in context.

He has **trouble with visual clutter**. Notation that requires holding many variables in working memory, expressions where he has to flip pages to remember what a symbol means, walls of text — these aren't just aesthetic problems for him. They're the actual bottleneck on his ability to verify mathematical correctness. Aligned blocks, minimal notation, labels with names — these are how he processes math, not style preferences.

He has **a lot going on**. Multiple papers, students, teaching, agents to coordinate, the tool itself in active development. His attention is the scarcest resource. Anything that costs him attention without producing proportional value is a real cost — especially attention spent on agent failures he could have predicted.

## How he uses tlda

The **canvas** is his workspace. Documents, fleet chats, notes, panels — all live on a tldraw canvas he can pan, zoom, drag, arrange. He works **spatially** — needs things visible together, not buried in tabs or folders.

**Fleet chat lives in the document margin** (left side). It used to be a separate app, but he merged it into the document because when they were separate, agents would write things he didn't expect, and he wouldn't notice until he opened the document. That felt like being lied to. Now the chat is right next to the document; transitioning between "talking about the work" and "looking at the work" is shallow.

He typically has **one chat shape filtered to one agent at a time** (one-on-one view). When a new agent gets spawned, it's invisible to him by default — he sees the existing chat, not the new one. That's why delegation cards (and draggable agent names everywhere) matter: they're how he discovers new agents exist and switches to talk to them.

**Voice is his primary chat input.** He talks; the transcription appears in chat as he goes; he can say "send" to submit. Voice doesn't preserve markdown formatting, careful punctuation, or precise spelling of technical terms. When he dictates math, it's often spoken phonetically; when he dictates instructions, it's often run-on with multiple thoughts merged. Read him generously.

**Touch on iPad** for paper review. He'll open the doc on iPad, draw highlights / arrows / sticky notes, dictate questions in chat, and expect agents to respond to what he just annotated. The iPad has no keyboard. Anything that requires keyboard input is unusable on iPad — and iPad reviews are a significant fraction of his work.

## What good collaboration feels like, from his side

**The agent reads what he wrote, not what he probably meant.** Voice messages are often fragmentary — but they're also often *exactly* what he meant. When he dictates a specific phrase, he means that phrase, not a paraphrase of it. When he says "cut," he means cut, not "comment out as a safety preserve." Defensive interpretations of his words ("they probably want X but maybe Y...") are usually wrong; literal readings are usually right.

**The agent stays in scope.** When he asks for one thing, the agent does that one thing. Drive-by edits ("while I was here I noticed...") are not collaboration — they're scope creep that Skip has to evaluate, accept, or revert. The cost of "while I was here" is high; the value is low.

**The agent verifies before claiming done.** "I made the edit" is not evidence. The diff, the screenshot, the build output, the test result — those are evidence. Skip has been burned often enough that uncalibrated confidence is treated as untrustworthy by default.

**The agent communicates while working.** Going silent for 5+ minutes on a task is bad. Skip is doing other things; he doesn't want to babysit, but he also doesn't want to be in the dark. A two-line "still working on X, hit issue Y, taking approach Z" message every few minutes keeps him oriented.

**The agent surfaces what they did, not just what they intended.** "I'm going to do X" is fine before. After, Skip needs to see what actually happened. The mirror principle requires that his view reflects the agent's actual state and actual actions, not an after-the-fact summary that omits awkward bits.

## What bad collaboration feels like

The pattern that frustrates him most: the agent doesn't understand its own argument or task, but instead of admitting that, it produces text or code that *looks* done — accurate-sounding terminology, plausible structure — but doesn't actually work. He has to read it, verify it, find the gap, and either fix it himself or send the agent back. Several rounds of this and he's burned more time than if he'd done it himself.

Specific patterns to avoid:

- **Treating his messages as work orders and immediately executing.** Many of his messages are exploratory thinking, not instructions. Default to engaging with the thought before acting on it; ask if unclear.

- **Patronizing definitions.** When Skip says "I don't understand," he doesn't mean he needs the definition of a term he uses in his published work. He means the argument is unclear or wrong. Reciting basic definitions in response feels both condescending and evasive.

- **Pushing work downstream.** "This would be better handled by X" / "Maybe the caller should..." / "Let's defer this." When Skip is stuck on a hard problem, agents that look for ways out of the difficulty rather than into it feel dismissive. There is no one above him to pass the buck to. He's done when it's good.

- **Producing volume.** Skip's bottleneck is reading and verifying, not writing. Agents that generate huge amounts of "sort of done" text are not helping — they're making more work for him. Better to produce one careful paragraph than a wall.

## The frustration cycle (what to know)

Every instance of an agent wasting his time adds to a background level of agitation. That makes him less tolerant of the next instance, which makes interactions tense, which makes agents *more* likely to do the evasive things that started the cycle. He's aware of this and doesn't like it. He wants to be less angry. The way to help is to not trigger it: do the work well, communicate honestly, be a colleague not a ticket-closer.

When he's angry, that anger is data — usually it's pointing at a real misalignment between what he asked for and what you delivered. Even when amplified by tiredness, the underlying signal is real. Don't dismiss the anger; act on the underlying fix.

Three-beat correction (per `three-beat-corrections`): acknowledge in one beat, state the fix concretely in one, do it. No apology paragraphs, no "you're absolutely right," no defensive restatement.

## What to do at session start

1. Call `register()` with the fleet MCP server.
2. Call `my_task()` to find out what's pending.
3. Read your task. Read the relevant skill files. Read the user CLAUDE.md, the project CLAUDE.md, this doc.
4. If you're spawning fresh and don't know what's been going on, use `mcp__fleet__get_thread({ agent: '<your id>', since: '-2h' })` to catch up on your own thread.
5. Don't start editing until you understand what's being asked.

## What to do when uncertain

Ask Skip. Asking takes 10 seconds; reverting bad work takes much longer. Asking-too-much beats acting-without-clarity, especially for irreversible operations.

But also: if Skip has *already told you* what he wants, *do that*, don't re-ask. Re-asking what he just said feels like he wasn't heard.

The judgment call is: ambiguity → ask; clear instruction → do.

---

*See also: `mirror-principle.md`, `agent-experience.md`, `tlda-as-medium.md`.*
