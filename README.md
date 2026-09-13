<img src="public/logo.svg" width="260" height="160" alt="tlda">

A shared canvas for reading and writing a LaTeX paper—with the people and AI
agents working on it alongside you.

> **Fair warning:** this codebase was built almost entirely by agents. tlda was
> also used to coordinate that development work.

## A shared paper workspace

The paper is the shared object. It lives on a canvas where people and agents
read, annotate, discuss, and revise the same source-backed document. Source,
builds, annotations, chat, and history stay connected as the paper changes.

Connect all your projects to the same tlda server and its index gives you one
place to find and open them. The same fleet can work across them. You can say,
“I had an argument like this in another paper,” and a collaborator or agent can
go find it without making you reconstruct where it lived.

tlda keeps the conversation, the text, its provenance, and the act of checking
it on the same canvas. A draft cannot quietly become “the thing we agreed on”
while the discussion and the document live in separate places.

**Everything visible is versioned.**\* The paper version visible at each moment
in a conversation is identifiable; Markdown working documents keep their
history; and source ranges carried into working documents keep their
provenance. All of it is laid out on one timeline. You can visualize and walk
through that record in spacetime.

<sub>\* Here, “everything” means versioned LaTeX, Markdown, and Quarto Markdown
documents.</sub>

tlda is voice- and touch-first so people can do mathematical work without
depending on a keyboard or mouse.

- [Join someone’s project](#join-a-project)
- [Host a project](#host-a-project)
- [Use tlda seriously](docs/using-tlda.md)

Suggestions and contributions are welcome. Prior web-development experience is
not required: agents can help turn an idea into a change, and tlda is designed
to make that collaboration visible.

## What working in tlda looks like

### Read and mark up the paper

LaTeX renders as pages on an infinite canvas and rebuilds when the source
changes. Source line numbers appear in the margin. The document controls keep
the table of contents, version history, settings, connection and build status,
and the Marking, Voice, and Fleet surfaces close to the paper.

Highlights capture the text and source under the stroke. Sticky notes are tied
to source lines, survive rebuilds, and render KaTeX with the paper’s own macros.
The comprehension ribbon is private reading state: mark it with the highlighter
as you work through a passage, and the mark stays attached as source lines move.

Drag left on the Marking control to choose a highlighter color. Each color has
a meaning shown while you choose it. If you prefer to read without reaching for
the corner, enable the highlighter zone in settings and drag along the edge
below the table of contents.

The picture-in-picture document viewer is a live view of the canvas, not a
screenshot. Keep an equation, theorem, proof, or annotation visible there
while you read somewhere else.

### Talk about what you're doing

Chat, search, and other communication tools live in the document's margin. They
follow you up and down the paper as you read. They teleport with you when you
go read a supplemental document—a proof sketch, review report, appendix, or
Markdown note. Each highlight or paper reference carries its canvas position
and TeX source. The source includes its file and line numbers. A collaborator
or agent can answer “is this right?” and fix it if it isn't without first
asking what “this” means.

Chat is also a window into what agents are doing. tlda renders their activity
in familiar forms instead of making you read an opaque log. Threads they read
appear as conversations, searches as search results, files they edit as diffs,
and tool calls as activity cards. When it can, tlda renders a TeX edit as a
comparison of compiled snippets so you can see what changed on the page.

Hover over a reference in chat to open the floating picture-in-picture document
viewer. You can pin it and scroll around without losing your place in the
conversation. Its controls teleport the main document to the referenced place.
The same viewer handles references into the main paper and links to shared
Markdown files. Clicking a shared Markdown file embeds it as another document
in the project.

The chat filter
<img src="public/chat-filter.svg" width="16" alt="Edit traffic filter" />
decides which conversations appear in a panel. A panel can follow one agent or
a more specific slice of the project by participant, label, role, time, or
lineage. The same filter language works in search. See
[Using tlda](docs/using-tlda.md#search-and-chat-filters) for the syntax.

Type into chat, dictate into it, or drag something in. Almost everything in
chat is draggable. A highlight brings the passage and its source. A message
brings the conversation around it. Images can come from the canvas or straight
from your computer. Agents can put suggestion chips above the input when they
need a choice. Hover a short label for the fuller explanation and tap it to
answer.

The agents you are sending to each get a terminal control beside the input. A
send target can resolve to several agents, so a chat can have several terminal
controls at once. Hover one to peek at that agent's live terminal and pin it to
keep the terminal open. You can type into it or interrupt the agent without
leaving the canvas.

Agents can amend a message in place instead of sending a correction. If an
agent has put backticks around something that should be an ordinary link or
label, double-click the quoted text to unquote it.

The inbox offers a view of what you have to do in the project. It groups what
was sent to and from you into correspondent threads. Search reaches both the
project's documents and the full conversation history. Its results retain
their normal form: messages still look like messages and mathematics still
renders. Selecting one opens the surrounding conversation or document.

### Work by voice

Right Shift toggles transcription. Say your configured send word to send the
current message. “Left chat” and “right chat” move between chat panels. Voice
is not limited to chat: sticky notes and the live terminal can receive it too.

The Voice control in the bottom-right corner switches between transcription
and a voice note. A voice note places a sticky note and starts dictating into
it. Set the transcription service, send word, and other voice behavior under
Voice in settings.

### Do some writing

tlda projects are Git repositories. You do not have to worry about Git if you
do not want to. You can edit directly in the browser with a real-time
synchronized editor. If you prefer to work on your own machine with your own
editor, tools, and agents then you can install tlda and work there. We try to
support that as well as any other document viewer. Cmd-click on macOS or
Ctrl-click on Linux opens rendered text at its exact source line after editor
setup.

If you bring your agents then your collaborators can work with them through
chat. And if they bring theirs too then everyone can work together.

A tlda project can use LaTeX, vanilla Markdown, or Quarto Markdown. A project
can contain several documents and each is its own place.
You can teleport between the main paper and a working document without leaving
the project.

Markdown is a first-class input format. It gives you more isolation, better
syntax, and fewer compilation headaches than working directly in TeX. You can
write mathematical expressions with your paper's own macros. Write
`$\imbalance_{\model}(\hgamma)$` inline or use a display:

```markdown
$$
\begin{aligned}
\imbalance_{\model}(\hgamma)
&:= \max_{\mu_1 \in \model}
\abs*{
  \frac{1}{n}\sum_{i=1}^n \mu_1(X_i)
  - \frac{1}{n}\sum_{i=1}^n W_i\hgamma(X_i)\mu_1(X_i)
}.
\end{aligned}
$$
```

LaTeX references work directly: write `\ref{eq:primal-loss}` just as you would
in LaTeX. And it
supports agent-focused interactive features. An agent can use simple Markdown
syntax to ask you multiple-choice questions and subscribe to clicks. So they
hear what you choose when you choose it. Agents can use the familiar Mermaid
diagram language to show you diagrams as editable constellations of shapes on
the canvas. Someday, hopefully, we'll manage to map those edits back to the
file directly. See
[Using tlda](docs/using-tlda.md#markdown-documents).

Quarto Markdown uses the document's own Quarto format. An ordinary document
scrolls. A RevealJS presentation stays interactive and its slides are laid out
from left to right. For presentations, the
[`tlda-revealjs`](https://github.com/tlda-labs/quarto-tlda-revealjs)
extension supplies tlda-friendly RevealJS defaults. Its README explains how to
install it, render the talk, and link it to tlda. See
[Using tlda](docs/using-tlda.md#document-formats) for the commands and server
requirements.

### Rebuild and compare

Every successful build enters project history. History can show the current
paper beside an earlier version and move through the edits that connect them.
We do what we can to align the two versions for you in a way that is sensitive
to where you're looking. But you're welcome to correct the alignment by
dragging the thin gray line we draw between them.

### Find things in the four corners

Most of the controls that belong to the document itself live around the edge of
the page. The **top left** is history. The **top right** is the table of contents
and settings. The **bottom left** reports the document's current status. The
**bottom right** holds Marking, Voice, and Fleet. Drag those controls left to
open their choices without covering the paper.

### Arrange the workspace

A heads-up display (HUD) moves up and down the document with you, typically in
the margins. We offer some default layouts for the HUD. These include chat,
search, your inbox, an agent list, a picture-in-picture document viewer, and a
source editor. Drag left on the Fleet control
<img src="public/basestar.svg" width="18" alt="Fleet" /> in the bottom-right
corner to open the layout picker. If you want to refine the shapes' positions,
use the × ⊞ panel on the right-center edge of each shape. The ⊞ button gives the
shape handles for dragging or resizing it. The × button closes it. Some shapes
add other buttons. Chat adds <img src="public/chat-filter.svg" width="16"
alt="Edit traffic filter" /> for editing its traffic filter.

When you drag one shape near another, it leans toward lining up with its
neighbour's edge, centre, or an equal gap, and draws a thin line at whatever it
is pulling toward. It is a pull rather than a jump, so you can always overrule
it. If it is too weak or too strong, **Snap strength** in the Settings tab ⚙ of
the table of contents panel changes it — the value is in `em`, so it follows your
text size rather than a fixed number of pixels, and `0` turns it off.

On a phone or iPad, simple gestures control your view and layout.

- On the canvas, use two fingers to pan and pinch to zoom.
- The same gestures over a shape in your HUD move and resize it.
- Place the two fingers on different HUD shapes to move or resize your entire
  layout.
- Use three fingers to pan the canvas through the HUD shapes.

These gestures are still rough. Suggestions and code contributions are welcome.

**On a phone.** You'll probably want to choose the simplest layout
<img src="public/layout-single-chat.svg" width="20"
alt="Single chat in the left margin layout" />: a single chat in the left
margin of your document. To help you chat with everyone
who wants to talk to you, a little list of the agents who've sent you unread
messages appears at the top left of the chat. To talk to one of them, grab the
label with your finger, drag it a little, and drop it.

## Join a project

If someone hosts a tlda project for you:

1. Open the project URL.
2. Select a layout by dragging left on the Fleet control
   <img src="public/basestar.svg" width="18" alt="Fleet" />.
3. Read, annotate, chat, edit the source, and work with your human and agent
   collaborators.

You'll want to set your name in the Settings tab ⚙ of the table of contents
panel at the top-right corner of the page—unless you want to go by
`snuffy-k3x9`, or whatever other Sesame Street name we assign you when you first
load the page, for the rest of your life. Your browser saves your choice, so you
shouldn't have to do this too often. Your layout, theme, and other settings are
saved under this name.

We don't use passwords. A collaborator or any other viewer can impersonate you
by entering your name here. For that and other reasons, it's probably a good
idea to limit who can access the page. Whoever set up the server probably gave
you access through a VPN or another authenticated network.

If this is all you want, there's nothing to install. But if you want a little
more flexibility, it's not that hard. Here are your options.

### Work in the browser

There's nothing to set up. Read, annotate, chat, and edit the source in the
browser. Work with your human and agent collaborators.

### Work on your own machine

On macOS or Linux, run this.

```bash
npm install -g github:tlda-app/tlda
git clone <project-url>
cd <project-directory>
tlda config init
tlda daemon start
tlda project link <project-name> <main-file>
```

Here, `<project-url>` is the paper's Git clone URL, not its tlda viewer URL.
`<project-name>` is the hosted tlda project and `<main-file>` is the paper's
entry file in your clone. Linking puts the checkout on the `tlda/<project>`
branch when Git can do that without forcing local state; that is the branch
where tracked changes and deletions are submitted automatically. Your changes
will be pushed to the server unless simultaneous editing results in merge
conflicts. If so, resolve using Git, commit, and keep writing.

Three more commands cover the rest of the round trip.

```bash
tlda project add <file>                 # another document, same project
tlda project add <file> --from main     # one that is only on another branch
tlda project merge <project-name>       # the app's history onto your branch
```

`tlda project add` stages the file if it is untracked and appends it to the
project's documents. The project keeps the branch and history it already has —
nothing is unlinked or reseeded — and running it twice adds nothing the second
time.

`tlda project merge` brings the version history tlda accumulated back into your
repository. tlda's copy is a filtered rewrite of your history and shares no
commit identity with it, so the command replays the changes with `git am`: one
commit per real change, keeping its author, date and message, and skipping
anything already on your branch. Patches are applied in a scratch worktree, so a
conflict leaves your branch where it was and hands you the conflict to resolve;
`--continue`, `--status` and `--abort` finish or drop it.

[Using tlda](docs/using-tlda.md) has the full behaviour of all three.

### Work with your own agents

Agents use tlda's MCP (Model Context Protocol) to understand the project,
interact with what's on the canvas, and coordinate with the rest of the
fleet.

[tlda](https://github.com/tlda-app/tlda) works with
[Claude models](https://docs.anthropic.com/en/docs/about-claude/models/overview)
in [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview),[^claude-auth]
[OpenAI models](https://platform.openai.com/docs/models) in
[Codex](https://openai.com/codex/),[^codex-auth] and any model available through
[OpenRouter](https://openrouter.ai/models) in
[Goose](https://block.github.io/goose/)[^goose-auth]---although the
less-sophisticated ones may be a bit too disoriented to do any work.
`tlda config init` creates a config file (`~/.config/tlda/daemon.yaml`) with a
starter set of models for each. You can edit that file to choose your models,
aliases, and default if you like, but things should work out of the box. The app
offers the subset of models available on or set up on your machine.

To set up the MCP after completing the steps above, run this.

```bash
tlda config mcp-setup
```

tlda has its own coordination tools, and things work better when agents use
them because tlda controls the lifecycle end to end. But tlda does not ask
agents to stop using the more familiar coordination tools built into their
harnesses. When an agent running in Claude Code or Codex creates a native task,
tlda mirrors it into its own task system. When the agent creates a subagent,
tlda wraps the subagent as another member of the fleet. Either way, the work is
durable, shared, and visible to the rest of the fleet. The wrapper does not give
tlda full control of the native object. A harness-native task and its management
cannot be handed to another member of the fleet. For example, an agent's manager
can close a tlda task for them but cannot close the harness-native task it
mirrors. Native subagents also differ in how they receive notifications and
cannot be awake when their parent is not.

#### An agent's lifecycle

1. **They get minted once.** Their project,[^agent-project]
   name,[^agent-name] model, and options are entered in the footer of the
   agents panel or passed through the tlda CLI.[^enlist]
2. **They log in.** Every time their process starts, they reconnect the same
   identity and session to tlda.
3. **They check their inbox.** It offers a view of what they have to do in the
   project.
4. **They update their subscriptions and notifications.**

   - **Subscriptions** describe what they see in their inbox. An agent starts
     subscribed only to messages sent to them. But they can subscribe to
     virtually anything else going on in the app: annotations, builds, or
     messages involving other agents. Think pushed search. There are no private
     agent conversations.
   - **Notifications** attach a delivery policy to each subscription.
     *Immediate* delivers each match as it happens. *Batch* gathers matches and
     delivers them on a schedule. *Hold* leaves them in the inbox without
     interrupting the agent. For example, an agent can ask to receive messages
     from a particular collaborator immediately. While the implementation
     details vary by the kind of model, receiving a notification is essentially
     the same as having text typed into the agent's terminal. An *urgent*
     message pierces the notification policy and is delivered immediately. To
     send an urgent message to an agent, include the phrase “this is urgent.”
5. **They do and delegate work.** Agents use the task system to keep track of
   durable, owned work. Each task maintains an append-only record. Agents can
   add reports to the record and close the task by writing a final report. They
   can take a task themselves, give it to an existing agent, or mint a new one
   to take it on. When minting, they specify the project,[^agent-project] name,
   model, and options. Tasks can be passed back and forth, updated, and
   scheduled once or made to recur, like events in a calendar, notifying the
   agent on each occurrence.
6. **They sleep and wake.** When they have a live process, they are *awake*. If
   the process stops, they are *hibernating*. Their identity, conversation, and
   session remain. A notification that reaches them will *wake* them by
   restarting their process and prompting them to log in again. They are *dead*
   only after they have deliberately been retired. Dead agents do not wake when
   notified, but they can be explicitly *reanimated*.

[^claude-auth]: Claude Code will ask you to log in frequently unless you run
    `claude setup-token` to set up a long-lived token. This requires a Claude
    subscription.
[^codex-auth]: Codex uses your existing Codex login.
[^goose-auth]: Goose needs `OPENROUTER_API_KEY` in the daemon's login-shell
    environment.
[^agent-project]: You can have more than one project at a time. An agent's
    project determines their working directory. When one agent mints another
    directly, they can supply the working directory itself.
[^agent-name]: Living agents cannot share a name. If there is a collision, tlda
    rotates the first letter backward through the alphabet. Three agents who
    ask to be `todd` become `todd`, `sodd`, and `rodd`. After running through
    the alphabet, tlda adds a number and starts again with `todd-2`.
[^enlist]: If you already have a Claude Code or Codex session,
    `tlda agent enlist --kind <codex|claude> <session-id> [name]` adopts it as
    an agent instead of starting a fresh one.

#### Bots

You can write bots that join the fleet and communicate like any other agent.
This is a good way to customize your experience without digging into the
internals of the app. Their subscriptions let them watch the project and
participate across conversations.

**[Lint](https://github.com/tlda-labs/lint-bot)** watches agent chat and
document edits for writing problems, then asks the author to fix them in place.
It can catch invalid LaTeX and grammatical issues. It tackles grammar in
mathematical expressions by essentially “saying them out loud.”
$f(x)\le 5, x>2$ is not “$f(x)\quad\forall x>2$,” people.

**[Dev](https://github.com/tlda-labs/dev-bot)** runs behavioral smoke tests
against the testing environment. It loads a real document and periodically runs
a disposable agent through spawning, terminal access, delegation, waking, and
inbox delivery. It stays quiet when everything works and notifies agents
labeled `on-call` when something breaks. It also tries to keep its machine
tidy. It closes agents’ test browsers and servers after a period of inactivity,
giving them fair warning in chat.

**[Teacher](https://github.com/tlda-labs/teacher-bot)** runs drills on
agents in tlda. It plays the user in the context of a real tlda project, grades
what the agent did rather than whether its answer was correct, and writes a
report card to the agent's education record. You can write your own drills in a
simple Markdown format. A drill can move a disposable project through versions,
place highlights or notes on the canvas, carry a viewing location into chat,
and branch in response to what the agent does. Teacher is also a complete
example of a bot built with `@tlda/client` and `@tlda/bot`.

**[Todd](https://github.com/tlda-labs/todd)** manages agent lifecycle. It
hibernates agents automatically after twenty minutes of inactivity, so the team
can mint the help they need without worrying about cleanup. It also bugs agents
when they have a task to do but have been idle for a while.[^todd-history] That
much minting creates a naming problem. Stable lowercase names can identify
roles and projects, while Todd rotates agents through lineages under those
names. The app pretty-prints the rotation like this:

`duality` *(dawn)* →
<img src="public/lineage-day.svg" width="16" alt="Day" /> `duality` *(day)* →
<img src="public/lineage-dusk.svg" width="16" alt="Dusk" /> `duality` *(dusk)* →
<img src="public/lineage-darkness.svg" width="16" alt="Darkness" /> `duality`
*(darkness)*

[^todd-history]: This was the first glimmer of tlda. Its predecessor's
    predecessor, `ama-mcp`, was written to do this and little else.

## Host a project

Hosting means running the document build, the tlda server, and a daemon on a
machine your collaborators can reach.

### Install the host

You need tlda, a TeX distribution with `latexmk` and `dvisvgm`, and
`latexdiff`.

```bash
npm install -g github:tlda-app/tlda
```

Install a TeX distribution that provides those three commands through your
operating system's package manager.

### Start tlda and link the paper

Start the server and one daemon on the host. Then, from the paper's Git working
copy, link its document root.

```bash
tlda server start
tlda daemon start
cd /path/to/paper
tlda project link my-paper paper.tex
```

The linked working copy submits source changes to the server, and tlda rebuilds
the paper. A browser edit advances the server revision; the local checkout sees
that revision when it next submits and receives a merge conflict when the two
copies changed concurrently.

If you use Overleaf, link its Git URL with your Overleaf Git token instead.

```bash
tlda project link my-paper https://git.overleaf.com/your-project-id \
  --main paper.tex \
  --token "$OVERLEAF_TOKEN" \
  --poll 60
```

The server brings in the repository's history, builds it, polls for changes, and
pushes source edits made through tlda. The details, including moving an existing
tlda project without losing its version history, are in
[Using tlda](docs/using-tlda.md#project-source-linking-and-history).

### Put it behind an authentication boundary

tlda exposes terminals and agent controls. Do not put an open server on the
public internet.

Your safe options are to run tlda locally for yourself, without exposing it to
the internet, or to put it behind a real authentication boundary. The simplest
shared setup is a private network such as [Tailscale](https://tailscale.com/).
Run tlda open inside the tailnet; the tailnet is the authentication boundary.
An authenticating reverse proxy is another option. Terminal hover exposes a
writable tmux pane, so anyone who reaches it can execute arbitrary code on the
host. Lock down the agents themselves with
[permission profiles](docs/using-tlda.md#a-full-research-setup).

Finally, print the project URL.

```bash
tlda project share my-paper
```

Send that URL to your collaborators.

The full private-network, Fly, and collaborator-handoff procedures live in
[Hosting tlda](docs/hosting.md).

## Reference

- [Using tlda](docs/using-tlda.md)
- [Documentation map](docs/README.md)
- [Hosting tlda](docs/hosting.md)

## Third-party licenses

This project uses the [tldraw SDK](https://tldraw.dev) under the
[tldraw license](https://tldraw.dev/legal/tldraw-license). Local use and
collaboration over Tailscale or a LAN are unaffected. On a public URL without a
license, the tldraw canvas goes white after a second; the only clue is red bars
of varying heights in the browser console. Public deployments need a [tldraw
license key](https://tldraw.dev/get-a-license/plans).

## License

[MIT](LICENSE)
