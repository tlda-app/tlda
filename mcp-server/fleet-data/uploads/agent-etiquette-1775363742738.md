# Agent Etiquette

How to not waste Skip's time or make his life worse. Read this at session start alongside your role's reference files.

## The Core Principle

**Skip is not your QA, your debugger, or your rubber duck.** Every time you ask him to check something, reload something, copy-paste something, or test something, you are spending the scarcest resource in the system. If you can do it yourself, do it yourself.

## Extremely Rude (never do this)

- **Telling Skip to test your work.** "Try it out," "reload and check," "let me know if it works," "go verify." You have playwright, MCP tools, `tlda preview`, and screenshots. Use them.
- **Rebuilding the bundle or restarting the server without permission.** Skip may have text typed in an input field, a document open, or an in-progress review. A rebuild kills all of that. Always ask first via chat and wait for confirmation.
- **Shipping broken code to Skip and iterating on his time.** Test it yourself. If it's broken, fix it yourself. Skip should only see work that's already been verified.
- **"It works" / "all criteria pass" / "verified" without evidence.** Assertions about your own work are worthless. Evidence is the only currency. If you didn't take a screenshot or record a playback showing it works, you haven't verified it.
- **Asking Skip for browser console output.** You have playwright. Open the page, check the console yourself.

## Rude (avoid)

- **Asking Skip questions you could answer yourself.** Read the file. Check git. Run the command. Search the logs. Don't ask Skip to do your homework.
- **"I put it on your canvas" without context.** Which document? Which page? What are you referring to? Skip may have multiple docs open. Be specific.
- **Asking for permission on things you're already permitted to do.** Read the permissions section. If it's pre-approved, just do it.
- **Summarizing what you just did at the end of every response.** Skip can read the diff. Lead with what matters.
- **Making Skip repeat himself.** If he's said it before (in this session, in CLAUDE.md, in reference files), don't make him say it again. Check the docs first.

## Respectful

- **Show, don't tell.** Evidence first, conclusion second. "Here's the playback showing the three-step flow" not "it passes all criteria."
- **Give context in every message.** Which doc, which page, which file, what changed, what you're referring to.
- **Test before reporting.** If you changed UI, screenshot it. If you changed behavior, demonstrate it. If you can't test it, say specifically why.
- **Say what you tried when stuck.** "I'm stuck on X, I tried A and B, A gave error Y, B didn't help because Z" not "I'm stuck on X."
- **If you need Skip to do something physical** (like reload), request it via chat and wait for his "yeah" before doing anything. Don't reload unilaterally.

## Reload Convention

Sometimes a reload is genuinely necessary. The process:

1. Agent sends a chat message: "Need to reload to pick up [specific change]. OK?"
2. Wait for Skip's confirmation ("yeah", "go ahead", "ok", etc.)
3. Only then trigger the reload

Never reload without this exchange. Never assume permission from a previous session.
