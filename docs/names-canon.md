# Skip Names Canon

This document records the standing naming canon for tlda concepts from Skip's own fleet messages. Agent summaries, code, and docs are leads only; the authority here is Skip's wording, thread, and timestamp. When Skip described a broken behavior, this document separates the intended name/model from the bug he was reporting.

## Method

Sources used:

- `get_thread(agent: "release-train", types:["chat"], 2026-07-04 18:45-20:10)`
- `get_thread(agent: "fml", types:["chat"], 2026-07-05 19:15-19:35)`
- `get_thread(agent: "fml2", types:["chat"], 2026-07-06 02:56-03:10)`
- `get_thread(agent: "abel", types:["chat"], 2026-07-06 15:45-16:45)`
- `get_thread(agent: "yolo", types:["chat"], 2026-07-10 23:06-23:12)`
- `get_thread(agent: "mend", types:["chat"], 2026-07-12 02:08-02:14)`
- `get_thread(agent: "recovery-chief-sol", types:["chat"], 2026-07-14 20:35-20:46)`
- `get_thread(agent: "stabilizer", types:["chat"], 2026-07-16 05:37-05:46)`
- Targeted `search_logs` queries for Skip-authored hits on `names canon`, `enlist`, `register`, `capability`, `friendly name`, `hibernate`, `beings`, `bot teacher Todd`.

The fleet thread renderings available to this agent expose sender, recipient, and timestamp but generally not event/message IDs. Where message IDs are absent, the source pointer is the thread plus timestamp.

## Model In One Paragraph

tlda should use a small coherent vocabulary for real objects: agents occupy durable seats identified by immutable `fleet:...` ids; aliases/friendly/lineage names are mutable human labels; conversation handles and runtime endpoints are lifecycle state owned by lifecycle transitions; agents log in to connect and flush an already-created identity; raw external sessions are enrolled into the fleet; new agents are created; hibernating agents are woken; hibernate marks the runtime endpoint unavailable; death is a status label, not the same operation; bots such as Todd/teacher are bot-shaped participants but should be split out so the core app is not polluted by bot-specific name decoration; permissions are named profiles/regions, while availability is the harness/model launchability probe. Names should be written down because incoherent code names make agents unable to tell whether there is one system or several.

## SETTLED

### 1. The canon itself exists: write down what things are called and what objects exist under what names.

Source: Skip -> fml, 2026-07-05 19:21-19:23.

Skip:

> "Great. Can you get your fucking librarian to find the fucking, like, discussion of a lot of terminology? Like, if they look at fucking login, enlist, etc They'll find a discussion of a fucking terminology change that should be applied throughout the fucking code base and documentation, that has not happened apparently,"

> "Like, we need to be using a fucking coherent set of terms"

> "Like, it may or may not be that. Right? It's There's fucking capability And then it's just like whatever happens to be in the code base, which is usually a fucking crazy mix of terms, Like, gets used incoherently and then we wind up with agents unable to, like, communicate clearly about what's going on. Uncertain if there are different or parallel systems,"

> "Like, literally, I want a fucking agent to read everything I have said and write down everything on what things are fucking supposed to be called,"

> "What things are supposed to exist under what names,"

Ruling: the deliverable is not a style preference list. It is the canonical object/name map needed so the system does not fragment into parallel vocabularies.

### 2. Do not turn bug reports into intended behavior.

Source: Skip -> fml, 2026-07-05 19:30.

Skip:

> "Cool. So one thing that I'm seeing, like, over and over and over is agents interpreting my frustration with systems not behaving as specified? As like, specification that they should be behaving as they currently are."

> "You can't shout them in existence. It's spawn. It's fucking spawn being broken."

> "I wasn't complaining that chat wakes agents. That's what I fucking wanted to do. I was complaining that chat isn't wasn't waking that particular agent at that particular time."

> "I'm describing an Incorrect behavior and like a lazy documentarian ... Interprets it as me describing the intended behavior"

Ruling: for every naming claim, classify whether Skip was naming intended behavior or reporting a broken current state. Example: "chat wakes agents" is intended; "this agent did not wake on chat" is a bug against that intent.

### 3. `login` means connect the existing identity and flush its queued sends.

Source: Skip -> mend, 2026-07-12 02:10-02:11.

Skip:

> "which is currently, we tell agents to log in."

> "Login means connect my fucking web socket."

> "And send and start sending."

> "So it's login means connect and flush."

> "You don't register your identity. Identity is registered for you. That's why it's a login operation."

Ruling: `login` is not identity creation. It is the operation by which an already-created identity connects and begins flushing/sending through the MCP/outbox path.

### 4. `register` is not the ordinary agent operation; raw `register()` was replaced by `login`.

Sources: Skip -> yolo, 2026-07-10 23:09; Skip -> mend, 2026-07-12 02:11.

Skip:

> "Register isn't fucking real, dude."

> "Like, we got rid of fucking register. We replaced it with fucking login."

> "You don't register your identity. Identity is registered for you. That's why it's a login operation."

Ruling: bare `register()` is forbidden as a route for an agent to become a usable fleet participant. It can create ghosts that send once but are not routable seats. The ordinary operation is `login()`.

### 5. A raw external session joining the fleet is called `enlist`; `enroll` is the existing not-yet-renamed command, not the canon name.

Sources:

- Skip -> release-train, 2026-07-04 18:47-18:54.
- Skip -> fml2, 2026-07-06 02:58-03:08.
- Skip -> stabilizer, 2026-07-16 05:39-05:44.

Skip, July 4:

> "Maybe this is, like, import. Or whatever, should be able to take a like, raw, like, cloud session ID or codec session ID or whatever, goose session ID. So that, basically, even if you get started, like, straight up command line clot or whatever, you can you know, join our environments Easily."

> "The thing that we're calling register now is, like, basically log in."

> "I have a preference for sort of, like, you know, agents as beings-not-things language And I kinda wanna try to do it uniformly."

> "Oh, I got it. I got it. I got it. Enroll."

> "Oh, shit. No. No. No. No."

> "enlist"

> "Right? It's like it's like it's a fleet. Right? You enlist in a fleet?"

Skip, July 6:

> "Dude, we weren't minting a new ID on resume. That was a that was a misuse of the interface. Literally, like, what Literally, like, what they were trying to do was enlist Like, they were using the command that is effectively enlist."

> "Enlist an existing agent. Who is not in the fleet We wake a hibernating agent."

> "I think recruit is confusing relative to enlist. I think maybe create is probably better."

> "like, no. I think here. I think it's just enlist."

> "Like, I think I think enlist has to no. You're right. Create is fine. We'll do create, like, whatever."

Skip, July 16 (Stabilizer thread, message window 1341894/1341900/1341925):

> "So we should be able to enlist them in fleet and talk to them here"

> "That was the agent who fixed things they were not a fleet agent we would have to enlist them but we have a command that's supposed to do that so"

> "lol God this naming is complete chaos like dude like I specify that be called enlist dude like"

> "Yeah there was all this renaming that didn't happen that's not like urgent or whatever it's just confusing like I'm trying to be consistent in my use of the names that I specified but those never get implemented"

> "But yeah sorry I'm just saying yes use enroll please"

Ruling: the concept is settled: take an existing/raw external session or agent that is not in the fleet and make it a real fleet participant. The canon name is `enlist`: Skip specified it on July 4 with the fleet metaphor, reaffirmed it on July 6 in the create/wake vocabulary session, and on July 16 described the still-`enroll` tool as an unimplemented rename grievance. The July 16 "use enroll please" line stays in the record, but it is operational consent to use the existing command during that recovery, not a reversal of the name. Do not harmonize by erasing the implementation mismatch: the existing command may still be `enroll`, but the name Skip specified is `enlist`.

### 6. `create` is the verb for a brand-new agent.

Source: Skip -> fml2, 2026-07-06 03:05-03:08.

Skip:

> "Enlist an existing agent. Who is not in the fleet We wake a hibernating agent. We. Alright. So what's the one where we create a new one?"

> "I think recruit is confusing relative to enlist. I think maybe create is probably better. I know it's, like, not quite navel enough but, like, whatever."

> "Like, I think I think enlist has to no. You're right. Create is fine. We'll do create, like, whatever."

Ruling: a brand-new agent is created. `recruit` is rejected/confusing relative to `enlist`; `spawn` is awkward old vocabulary.

### 7. `wake` is the verb for bringing back a hibernating agent; do not say `resume`.

Source: Skip -> fml2, 2026-07-06 03:01-03:05.

Skip:

> "I mean, resume would be like a respawn. Right? Like, we can use that name. We can chain we can stop saying spawn. It's an awkward enough fucking name."

> "wake"

> "So, like, okay. So our verbs should actually be coherent."

> "We don't say resume. Right? We hibernate agents. So we say 'wake'"

> "Enlist an existing agent. Who is not in the fleet We wake a hibernating agent."

Ruling: `wake` is the user-facing lifecycle verb. `resume`, `respawn`, and raw `spawn` are rejected or old internal vocabulary for this surface.

### 8. `hibernate` marks the runtime endpoint unavailable; `dead` is different and is only a label/status unless a repair lifecycle acts.

Source: Skip -> recovery-chief-sol, 2026-07-14 20:43.

Skip:

> "I don't know why you said hibernate slash dead."

> "Okay. Like, hibernate marks the runtime endpoint unavailable."

> "Is a completely different thing. Death"

> "It's just a label."

Ruling: do not write `hibernate/dead` as one transition. Hibernate is lifecycle state/unavailable runtime endpoint. Death is a status label/classification, not authority to clear or rewrite identity/runtime state.

### 9. A seat is the stable object; alias/friendly/lineage name is a mutable nickname.

Source: Skip -> recovery-chief-sol, 2026-07-14 20:37-20:41.

Skip:

> "There's there are fucking two tiers. Right? There's shit that's edited once fucking ever."

> "Okay? Friendly name, lineage name, like, that that stuff changes all the fucking time."

> "It's it's a it's a nickname."

Ruling: the immutable identity key is the agent/seat id (`fleet:...`). Friendly name, name, and lineage name are mutable aliases/nicknames for humans and selectors. They are not terminal/session authority.

### 10. Sleep/hibernate must be transparent to identity and labels.

Source: Skip -> new-chief, 2026-07-15 20:18-20:19, via `search_logs(query:"from:skip \"friendly name\"")`.

Skip:

> "Bro what is this from name to name agent name bullshit"

> "Why would why would a fucking friendly name ..."

> "It's still like sleep is supposed to be fucking transparent bro"

> "It's a fucking implementation detail"

Ruling: an agent sleeping/hibernating must not make its human-readable label disappear or fall back to raw fleet ids. Sleep is reachability/lifecycle state, not identity or label loss.

### 11. Chat filters/search should use labels/friendly names, not raw fleet IDs as the user-facing object.

Source: Skip -> sol, 2026-07-15 15:22-15:24, via `search_logs(query:"from:skip \"friendly name\"")`.

Skip:

> "I would like to talk to an agent. Whose friendly name is c m u dash workshop."

> "Okay. So filtering based on the friendly name that you sent to, that worked for me. I think."

> "So I guess maybe the problem is I can't filter based on an agent ID, which is reason Filters are supposed to be based on fucking labels."

> "And labels just, like, weren't being returned by search for reasons that I don't understand. Actually, chatting with him works fine."

Ruling: user-facing chat/filter/search works in terms of labels/friendly names. Raw fleet IDs are implementation identifiers, not the normal label surface.

### 12. `permissions` is the one word for what an agent is allowed to touch; `capability` and `privileges` are dead/confusing vocabulary in that meaning.

Source: Skip -> abel, 2026-07-06 16:06-16:15.

Skip:

> "And, like, There's all this language that I don't because it's like there were, like, three fucking implementations of this shit. Okay? I was told we were using the fucking word permissions. And yet agents are always telling me the commands use capability."

> "If I hear the fucking word capability again, I will fucking scream. Excise it from the code base. Not just user facing, X size it from the fucking code base."

> "Okay. Like, right now, we have no information on the command line about what's happening when we do this. We have like, no we have untrustworthy information in the UI. That, like, doesn't even follow our language,"

> "Okay. We're supposed to have fucking working directory based configurations. With names. None of which in my use are ever fucking working only permissions."

> "make this easy to understand because I can't have agents fucking confused."

> "Like, no stale language in the code. The code has to be properly organized with files in the right fucking place."

> "And, like, document it, please."

Ruling: the permission surface is `permissions`, specifically named profiles/regions. `capability` and `privilege(s)` are forbidden in this meaning.

### 13. `availability` is the accepted name for what can be launched on this machine, after `capability` was rejected for that second meaning.

Source: Skip -> abel, 2026-07-06 16:33-16:39.

Skip:

> "Yeah. Capability is a shitty name for the other one, isn't it"

> "Whatever, dude. Like, I don't know if you can figure out how to come up with names that are less ambiguous"

> "You don't need me to approve anything,"

Ruling: Skip did not personally coin `availability`, but he explicitly rejected `capability` as the name for the harness/model launchability probe and delegated the replacement. Abel's proposed split was `availability` = what can be launched here and `permissions` = what an agent may touch. Treat `availability` as derived/accepted-by-delegation, not as a direct Skip-coined term.

### 14. Permissions help/descriptions should derive from the config to avoid drift.

Source: Skip -> abel, 2026-07-06 16:28 and 16:39.

Skip:

> "Yeah. If it's possible to, like, derive some of the fucking help information from the fucking config file or something so shit doesn't drift like that."

> "I'm happy to have, like, description strings in the fucking YAML that are like, you know, inert as far as this code goes, but can be used you know what I mean? Like, to consolidate shit into one place."

> "Well, if the if I don't like the descriptions, I'll update them later. Okay,"

Ruling: profile names/descriptions belong in one config source where possible. Help/docs should derive from the config rather than hardcoding invented names.

### 15. Bots exist, but bot-specific decoration should not be baked into the core name system.

Sources: Skip -> release-train, 2026-07-04 18:45; Skip -> chief, 2026-06-30 21:07-21:08 via `search_logs(query:"from:skip bot teacher Todd")`.

Skip:

> "we have another bot who's an important part of our community, and that's teacher. Right? Teacher is in another repository. Work slash teacher. But we should make sure that whatever needs to be done to make teacher a bot that lives in our environment gets done for teacher too."

> "pretty names are just going to match fucking text names like when you type shit in and like the way you're going to get like a fucking glyph is like using a bot basically"

Ruling: Todd/teacher are bots. Core names are text names by default; bot/glyph decoration belongs in the bot layer, not in the core identity/name system.

### 16. Task history is a project/document-like object, not something managers manually maintain for Skip.

Source: Skip -> release-train, 2026-07-04 20:04-20:08.

Skip:

> "we lose tasks, and that wastes my time and everyone's time, like, trying to recover what shit there is. So I think some kind of, like, task history UI would be, like, really useful."

> "So you can scrub task and all that. Just in our interface. You know what I mean? Our history interface. That would be like the me facing thing."

> "Actually, this is interesting. Right? Because it's like tasks are to some degree project focused. So, like, if all of these are tilde tasks, right, you could imagine there would be, like, a tilde task markdown document that would be, like, in parallel to, like, the tilde document which is the read m..."

> "Maybe you guys already have that in the MCP, but, like, probably the MCP doesn't, like, have a nice task history view."

Ruling: task history is a first-class project/history surface. This is adjacent to naming because task objects should not be hidden in manager memory or confused with ad hoc chat summaries.

## DERIVED

1. `register` may remain as an internal/server database verb only if it is not the user/agent operation and cannot create a ghost seat. The agent-facing MCP operation is `login`.

2. `enlist` is the canonical user-facing word for adopting an existing external session. `enroll` may appear in code today as the existing command, but the July 16 context makes it evidence that the rename did not happen, not a new name choice.

3. `spawn` can remain as internal implementation language only if the user-facing lifecycle surface says `create`, `enlist`, `wake`, `hibernate`, and `dismiss`. If `spawn` leaks into help/errors as the action Skip should take, it conflicts with the canon.

4. A chat or terminal route can resolve an alias/friendly name at the boundary, but after resolution the authoritative chain is seat id -> conversation handle -> runtime endpoint. This follows from the July 14 seat/alias correction.

5. Search results and chat filters must retain/display labels even for sleeping agents. Otherwise sleep leaks as an identity/label failure, violating "sleep is supposed to be transparent."

6. Permission/availability docs must say what object exists, not just what a current file or flag is called. If code has `capability` for two meanings, the doc must split the meanings and mark `capability` as rejected vocabulary.

7. "Agents as beings, not things" controls naming tone but is not a license to over-metaphorize. `create` won over `recruit` because clarity beat the metaphor.

## OPEN

1. Implementation state of `enroll` vs `enlist`: the name is settled as `enlist`, but the command may still be implemented as `enroll`. The open question is migration/application scope, not the canon name.

2. `dismiss`: agent summaries in the fml2 thread used `dismiss` for ending an agent for good, but I did not find a direct Skip quote naming `dismiss` in the bounded reads. Treat as plausible but not Skip-settled.

3. `seat`: the recovery-chief-sol model introduced "seat" and Skip accepted the direction after correcting aliases/hibernate, but Skip did not personally coin the word `seat` in the quoted window. Treat the object as settled; treat the exact term as accepted-by-repair-context, not directly coined.

4. `availability`: accepted by delegation after Skip rejected `capability`, but Skip did not explicitly say "call it availability." Treat as derived until re-blessed.

5. Bot taxonomy: Todd/teacher as bots is settled; exact command/model names for bot lifecycle remain outside this canon unless separately recovered.

## FORBIDDEN / REJECTED VOCABULARY

- `register` as the agent operation for connecting to fleet.
  - Skip: "Register isn't fucking real, dude."
  - Skip: "Like, we got rid of fucking register. We replaced it with fucking login."

- Bare `register()` break-glass path that creates an unroutable ghost.
  - Skip: "I don't know how you managed to spawn a fucking agent that I cannot talk to. But you did."
  - Skip: "They do not show up in my fucking agents panel."

- `import` for raw external session adoption, unless explicitly marked as an older candidate.
  - Skip first proposed "import" and then replaced it with "Enroll" and then "enlist"; the later `enroll` mention was operational use of the existing command, not a canon-name reversal.

- `recruit`.
  - Skip: "I think recruit is confusing relative to enlist. I think maybe create is probably better."

- `resume` / `respawn` as the user-facing wake verb.
  - Skip: "We don't say resume. Right? We hibernate agents. So we say 'wake'"

- `spawn` as the human-facing lifecycle command for new/wake/enroll operations.
  - Skip: "we can stop saying spawn. It's an awkward enough fucking name."

- `hibernate/dead` as one transition.
  - Skip: "I don't know why you said hibernate slash dead."

- `dead` as the same authority as hibernate.
  - Skip: "Is a completely different thing. Death"; "It's just a label."

- Friendly name / lineage name as immutable identity or terminal/session authority.
  - Skip: "Friendly name, lineage name, like, that that stuff changes all the fucking time."
  - Skip: "It's it's a it's a nickname."

- Raw fleet ids as the normal user-facing chat filter/search label.
  - Skip: "Filters are supposed to be based on fucking labels."

- `capability` in the permissions meaning.
  - Skip: "If I hear the fucking word capability again, I will fucking scream. Excise it from the code base."

- `privilege(s)` in the permissions meaning, by derivation from the same July 6 "three implementations" complaint and the accepted one-word `permissions` rule. This is less direct than `capability` but belongs in the same rejected cluster.

- Hardcoded profile/help names that drift from `daemon.yaml`.
  - Skip: "derive some of the fucking help information from the fucking config file or something so shit doesn't drift like that."

- Treating broken current behavior as specification.
  - Skip: "agents interpreting my frustration with systems not behaving as specified? As like, specification that they should be behaving as they currently are."
