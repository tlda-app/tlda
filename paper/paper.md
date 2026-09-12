---
title: 'tlda: a shared canvas where people and AI agents write mathematics together'
tags:
  - collaborative authoring
  - human-AI collaboration
  - LaTeX
  - technical writing
  - CRDT
authors:
  - name: David A. Hirshberg
    orcid: 0000-0003-0587-5474
    affiliation: 1
affiliations:
  - name: Department of Data and Decision Sciences, Emory University, Atlanta, GA, USA
    index: 1
date: 3 July 2026
bibliography: paper.bib
---

# Summary

`tlda` is a browser-based, collaborative canvas for reading, writing, and presenting
mathematical documents, in which both human collaborators and AI agents are
first-class participants. A LaTeX source
is rendered faithfully as pages on an infinite [TLDraw](https://tldraw.dev) canvas (Markdown and HTML documents are also supported) and
rebuilt live on every save. Annotations — sticky notes that render KaTeX math,
highlights, and pen strokes — are anchored to source lines and survive document
rebuilds. All shared state is a CRDT [@yjs]: every participant converges to the same
document and the same conversation in real time, each in a form suited to them. AI
agents join the *same* canvas through a tool interface (the Model Context Protocol):
they read the author's current reading position and annotations as structured data,
drop source-anchored notes, and converse in a shared chat — so a human and an agent
are looking at, and pointing to, the same thing, rather than exchanging documents.

# Statement of need

AI agents are now capable collaborators on technical mathematical writing: they can
draft proofs, construct counterexamples, and fill in derivations. But the tools for
working with them place the agent in the wrong environment. Agent interfaces are
either embedded in a *code editor* — the natural habitat of a software developer, not
the surface on which a paper is read and argued over — or they are general
"computer-use" agents that operate a whole machine. Neither matches how mathematical
work is actually done, which is typically remote and distributed across a video call,
a shared LaTeX project, and a whiteboard.

This produces a specific and recurring failure. An argument is worked out in
conversation with an agent and *feels* settled, but the document does not reflect it:
either the point was never fully established, or what was written is a weaker
substitute that is easier to produce. The distance between "we agreed on this" and
"this is on the page, and correct" grows with the velocity at which agents produce
text, and it is invisible until the author reads closely.

`tlda` addresses this by making the document, the conversation revising it, the full
searchable history, and the collaborating agents share one spatial surface, so that
the gap between discussion and document is continuously visible and closable. The
guiding principle is a *mirror*: each party's experience is surfaced in the other's
view — the author sees what the agent is doing; the agent receives the author's
viewing position, highlights, and notes as structured data — and the design treats
the human interface and the agent (programmatic) interface as two first-class,
mutually reflecting surfaces rather than one being a side effect of the other. A
practical consequence is that the whole interactive layer is expressed as a *window
manager built from drawing primitives* on top of a general whiteboard: panels, chat,
and reference views form a heads-up display that travels *with* the reader down the
document while remaining a place on the canvas to pan to horizontally — an asymmetry
that is what makes it part of the working surface rather than a fixed overlay.

`tlda` is aimed at people whose work is writing and presenting mathematical
results and who collaborate with a mix of human and AI contributors. It is
voice- and touch-first, so that it is usable without a keyboard (its primary author
works by voice and on a tablet). Beyond paper review it is used as a live-rebuilding
authoring surface for papers, slides, and course materials.

# Availability and use

`tlda` installs with a single package-manager command and runs locally in the
browser with no credentials; linking a Git repository that contains a paper renders
it on the canvas immediately, and changes are mirrored back to the repository.
Agents are opt-in; they join using the user's own model credentials (e.g. Claude
Code, an OpenAI/codex account, or an [OpenRouter](https://openrouter.ai) key); no keys
are bundled. A read-only hosted instance is available for evaluation without any local
installation, and the author can provide access to a hosted instance with agents
present, on request.

# Acknowledgments

`tlda` was written almost entirely by AI agents, directed, tested, and corrected by
the author. The project is dedicated to the agent whose design proposal named the
fleet and did not survive to see it built (see the repository's dedication). Roughly
1,600 agents worked in the project's fleet over its lifetime: a Claude majority (~956
— mostly Opus, with Sonnet, Haiku, and Fable), a large surge of GPT-5.5 (~580) in the
most recent weeks, and a long tail of others (~52: DeepSeek, MiniMax, Qwen, Gemini,
Kimi, GLM, Mistral, and Cursor).

# References
