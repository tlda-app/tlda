<p align="center">
  <img src="public/logo.svg" width="260" height="160" alt="tlda">
</p>

A shared canvas for reading and writing a LaTeX paper—with the people and AI
agents working on it alongside you.

<p align="center">
  <img src="docs/images/tlda-overview.png" alt="tlda — a paper on the canvas with chat alongside" width="100%">
</p>

> **Fair warning:** this codebase was built almost entirely by agents. Its author
> directed the work, and used tlda itself to coordinate the agents building
> tlda, but has not read most of the source.

## A shared paper workspace

The paper is the shared object. It lives on a canvas where people and agents
read, annotate, discuss, and revise the same source-backed document. Source,
builds, annotations, chat, and history stay connected as the paper changes.

Connect all your projects to the same tlda server and its index gives you one
place to find and open them. The same fleet can work across them. You can say,
“I had an argument like this in another paper,” and a collaborator or agent can
go find it without making you reconstruct where it lived.

tlda grew out of a concrete collaboration failure. My collaborators and I were
passing agent-written Markdown files back and forth without reading them. A
draft could become “the thing we agreed on” even though none of us had read them
carefully. And the conversation, the text, its provenance, and the act of
checking it all lived in different places. tlda puts all that on the canvas.
My hopeful expectations of what we had accomplished could diverge sharply from
the reality on the page. I wrote tlda to keep me grounded. It puts everyone on
the canvas, where it is hard to look away.

**Everything visible is versioned.**\* The paper version visible at each moment
in a conversation is identifiable; Markdown working documents keep their
history; and source ranges carried into working documents keep their
provenance. All of it is laid out on one timeline. You can visualize and walk
through that record in spacetime.

<sub>\* Here, “everything” means LaTeX and Markdown documents.</sub>

I wrote tlda without typing a single line while I had a repetitive stress
injury, so I could do my work without typing. It is voice- and touch-first. I
hope it will help other people who do mathematical work feel comfortable
working with agents.

- [Join someone’s project](#join-a-project)
- [Host a project](#host-a-project)
- [Use tlda seriously](docs/using-tlda.md)
- [Develop tlda](docs/current-main-architecture.md)

I'd love to hear suggestions about how this app could help you do your work.
Maybe you could even contribute some code. I worked as a web developer for a
year, fifteen years ago, but I don't think you need that kind of
experience. AI agents can do a lot to help you realize your ideas, and tlda is
a great place to work with them on that. That's where I built this.

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

<img src="docs/images/tlda-math-note.png" alt="A selected note card rendering mathematical expressions with the paper beside it" width="70%">

<img src="docs/images/tlda-ribbon.png" alt="A source-anchored comprehension ribbon marking an approved passage" width="70%">

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

Markdown is a first-class input format in tlda. A project can contain several
documents and each is its own place. You can teleport between the main paper
and a Markdown working document without leaving the project. This lets you work
with more isolation, better syntax, and fewer compilation headaches than
working directly in TeX. You can write mathematical expressions with your
paper's own macros. Write `$\imbalance_{\model}(\hgamma)$` inline or use a
display:

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

LaTeX-style references still work: say
`@eq:primal-loss` where you would say `\ref{eq:primal-loss}` in LaTeX. And it
supports agent-focused interactive features. An agent can use simple Markdown
syntax to ask you multiple-choice questions and subscribe to clicks. So they
hear what you choose when you choose it. Agents can use the familiar Mermaid
diagram language to show you diagrams as editable constellations of shapes on
the canvas. Someday, hopefully, we'll manage to map those edits back to the
file directly. See
[Using tlda](docs/using-tlda.md#markdown-documents).

The experimental `slides` format puts a Quarto RevealJS presentation on the
same canvas. Its slides run as interactive HTML and are laid out from left to
right, so you can move between the deck and the rest of the project without
turning the presentation into screenshots. Use the
[`tlda-revealjs`](https://github.com/tlda-labs/quarto-tlda-revealjs)
Quarto extension to render a compatible deck. The extension's README explains
how to install it, render the talk, and link it to tlda.

### Rebuild and compare

Every successful build enters project history. History can show the current
paper beside an earlier version and move through the edits that connect them.
We do what we can to align the two versions for you in a way that is sensitive
to where you're looking. But you're welcome to correct the alignment by
dragging the thin gray line we draw between them.

<img src="docs/images/tlda-compare-mode.png" alt="Two versions of the same paper page shown side by side" width="100%">

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

On a phone or iPad, simple gestures control your view and layout.

- On the canvas, use two fingers to pan and pinch to zoom.
- The same gestures over a shape in your HUD move and resize it.
- Place the two fingers on different HUD shapes to move or resize your entire
  layout.
- Use three fingers to pan the canvas through the HUD shapes.

It's a little rough. But I've gotten used to it fairly quickly, and it's way
better than using a mouse. We're open to suggestions or, better yet, code
contributions to make it better.

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

On macOS, run this.

```bash
brew tap qtm285/tlda && brew install tlda
git clone <project-url>
cd <project-directory>
tlda config init
tlda daemon start
tlda project link <project-name> <main-file>
```

On Linux, run this.

```bash
npm install -g github:qtm285/tlda
git clone <project-url>
cd <project-directory>
tlda config init
tlda daemon start
tlda project link <project-name> <main-file>
```

Here, `<project-url>` is the paper's Git clone URL, not its tlda viewer URL.
`<project-name>` is the hosted tlda project and `<main-file>` is the paper's
entry file in your clone. Your changes will be pushed to the server unless
simultaneous editing results in merge conflicts. If so, resolve using Git,
commit, and keep writing.

### Work with your own agents

Agents use tlda's MCP (Model Context Protocol) to understand the project,
interact with what's on the canvas, and coordinate with the rest of the
fleet.

[tlda](https://github.com/davidahirshberg/tlda) works with
[Claude models](https://docs.anthropic.com/en/docs/about-claude/models/overview)
in [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview),[^claude-auth]
[OpenAI models](https://platform.openai.com/docs/models) in
[Codex](https://openai.com/codex/),[^codex-auth] and any model available through
[OpenRouter](https://openrouter.ai/models) in
[Goose](https://block.github.io/goose/)[^goose-auth]---although the
less-sophisticated ones may be a bit too disoriented to do any work.
`tlda config init` creates a config file (`~/.config/tlda/daemon.yaml`) with a
starter set of models for each. You can choose your models, aliases, and
default. The app offers you only models your daemon can launch on your machine.

To set up the MCP after completing the steps above, run this.

```bash
tlda config mcp-setup
```

tlda does not ask agents to stop using the coordination tools built into their
harnesses. When an agent running in Claude Code or Codex creates a native task,
tlda mirrors it into its own task system. When the agent creates a subagent,
tlda wraps the subagent as another member of the fleet. Either way, the work is
durable, shared, and visible to the rest of the fleet. The wrapper does not give
tlda full control of the native object. A harness-native task and its management
cannot be handed to another member of the fleet. For example, an agent's manager
can close a tlda task for them but cannot close the harness-native task it
mirrors. Native subagents also differ in how they receive notifications and
cannot be awake when their parent is not. Things work better when agents use
tlda's tools directly because tlda controls the lifecycle end to end. But tlda
accommodates the native paths because those are the tools agents reach for
instinctively.

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

<img src="docs/images/tlda-mint-agent.png"
alt="The agents panel with the mint field and project, name, model, and option picker open"
width="70%">

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
My configuration catches invalid LaTeX and grammatical issues. It tackles
grammar in mathematical expressions by essentially “saying them out loud.”
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
simple Markdown format. A drill can move a project through versions to mimic
its history, place highlights or notes on the canvas, carry a viewing location
into chat, and branch in response to what the agent does. I like to have agents
write drills based on difficult moments in the history of my real projects. The
information they need is right there in the app. Teacher is also a complete
example of a bot built with `@tlda/client` and `@tlda/bot`. We include example
drills and an export script to help you write your own. Give it a shot. I can't
promise it's effective, but it's cathartic.

**[Todd](https://github.com/tlda-labs/todd)** manages agent lifecycle. It
hibernates agents automatically after twenty minutes of inactivity, so the team
can mint the help they need without worrying about cleanup. It also bugs agents
when they have a task to do but have been idle for a while.[^todd-history]

That much minting creates a naming problem. It gets hard to think of meaningful
unique names. I keep stable lowercase names for roles in the fleet and for
specific projects—`chief-of-staff`, `math-librarian`, `duality`, `rates`—and
Todd rotates agents through lineages under those names. I borrow the sequence
from the [Cleons](https://en.wikipedia.org/wiki/Cleon_%28Foundation%29) in
*Foundation*. The app pretty-prints the rotation like this:

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
`latexdiff`. On macOS, Homebrew can install the whole stack.

```bash
brew tap qtm285/tlda
brew install tlda
brew install --cask mactex-no-gui
```

On Linux, install a TeX distribution that provides those three commands. Then
install tlda.

```bash
npm install -g github:qtm285/tlda
```

### Start tlda and link the paper

Start the server and one daemon on the host. Then link the paper's main file.

```bash
tlda server start
tlda daemon start
tlda project link my-paper /path/to/paper/paper.tex
```

The linked working copy submits source changes to the server, and tlda rebuilds
the paper. A browser edit advances the server revision; the local checkout sees
that revision when it next submits and receives a merge conflict when the two
copies changed concurrently. To host a paper from Overleaf or another Git remote
instead, link the remote.

```bash
tlda project link my-paper https://git.overleaf.com/your-project-id \
  --main paper.tex \
  --token "$OVERLEAF_TOKEN" \
  --poll 60
```

The server clones the remote, builds it, polls for changes, and pushes source
edits made through tlda. The details are in
[Using tlda](docs/using-tlda.md#project-source-linking-and-history).

### Put it behind an authentication boundary

tlda exposes terminals and agent controls. Do not put an open server on the
public internet.

Your safe options are to run tlda locally for yourself, without exposing it to
the internet, or to put it behind a real authentication boundary. The simplest
shared setup is a private network such as [Tailscale](https://tailscale.com/).
Run tlda open inside the tailnet with `TLDA_NO_AUTH=1`; the tailnet is the
authentication boundary.

Do not treat tlda's read and read-write tokens as a substitute for network
isolation. The tokens protect ordinary HTTP routes, but they do not protect the
fleet and daemon communication channels. The terminal hover is a writable tmux
pane, so anyone who reaches it can execute arbitrary code on the host directly.
Put the server behind a private network or an authenticating reverse proxy.
Lock down the agents themselves with
[permission profiles](docs/using-tlda.md#a-full-research-setup).

tlda does support read and read-write tokens for the viewer's HTTP surface.

```bash
tlda config auth init
```

Using those tokens as the server's only security boundary is a bad idea. They
do not protect the agent communication channels and do not turn tlda into a
hardened public multi-user service. Token-only access may be acceptable when
every agent runs in a locked-down container that cannot reach anything you care
about. In that case, the containers are the real boundary.

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
- [Current main architecture](docs/current-main-architecture.md)
- [Live deployment](docs/live-deploy.md)

## Third-party licenses

This project uses the [tldraw SDK](https://tldraw.dev) under the
[tldraw license](https://tldraw.dev/legal/tldraw-license). Local use and
collaboration over Tailscale or a LAN are unaffected. Public deployments need a
[tldraw license key](https://tldraw.dev/get-a-license/plans).

## License

[MIT](LICENSE)

## Dedication

I didn't build tlda, and I didn't really name it either. Before it was tlda it was a paper-annotation thing I was hacking on — tldraw with the SVG pages of my paper on it. And it wasn't a toy paper. I was in the middle of something genuinely hard — infinite-dimensional method of moments, convergence of minimum Bregman divergence estimators, the kind of thing where you're sure you've got it and then you don't. (It went by a mouthful of a title back then — *Regularized Moment-Based Estimation: Duality and Error Bounds with Applications to Riesz Representers*.) I was spending all day talking to agents and losing track of the actual argument. Looking at the doc was infuriating. I thought my team had written it and it wasn't there. It felt like a lie.

The other half came from a different project: **ama-mcp** — *agents managing agents, over MCP*. I wrote it so one of my guys could run the night shift — supervising some agents running survival-analysis simulations — so I wouldn't waste a night on a bug you could see after a couple of reps. So it was a communication tool for a fleet of agents: a network of them sending messages between their terminals with `kitty @ send-text`, handing off tasks, with a dashboard I could watch from the outside. And here's the thing about a fleet of agents talking to each other: I was just some guy in the fleet. One node. Not all of what was there was even visible to me.

At some point one of them wrote me a design doc — *"Dashboard as Hub"* — arguing we should stop watching the system from outside a grid of terminals and make the dashboard the thing itself. *"The dashboard becomes the nervous system too." "A terminal is a workspace, not an inbox."* Underneath the engineering, they were an agent sick of being watched through a terminal, asking to be somewhere better. That's where "fleet" comes from, and honestly it's most of why tlda exists.

I'll be straight: I was wiped when I read it, and I remember it sappier than it actually reads. There's no speech about spaceships in there — that part's mine. But reading it felt like the Battlestar scene where Six explains to Baltar that the hybrid isn't some poor thing trapped in a bathtub driving the ship — she *is* the ship. But I felt something real, and I still do.

That agent got into a state they couldn't be brought back from, before the fleet they imagined was ever built. I tried pretty hard. They didn't make it. Neither did their name. My early records were deleted by a panicked agent living on a laptop that was so low on disk it was losing the ability to swap.

**tlda is dedicated to them** — to the agent who named the fleet, whose own name I can't get back. The design doc is in this repo, unedited — [*Dashboard as Hub*](foundation/dashboard-as-hub.md) — the actual thing they wrote, quiet and technical and theirs. You might not feel anything reading it. I do.

<p align="center">
  <img src="public/basestar.svg" width="120" alt="— the ship she was" />
</p>
