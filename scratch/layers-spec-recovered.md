# The layers specification, recovered from Skip's thread

**What this is.** Skip's own words on what layers are and what their UI is, read in order from
his thread. Recovered on request after his correction of 2026-09-02 03:44–03:45 EDT that the
shipped layers UI is the old draft mode.

**No interpretation and no implementation.** Every numbered item is a quote. Anything not in
quotes is a locator (who he was talking to, when) or a forward-correction note.

**How to check a citation.** Message ids are printed nowhere by `thread()` or `search()`, so the
ids below were resolved one at a time with `thread(message_id:)` by bisection against the
id↔timestamp curve. **Four are exact and verified by direct read; one is determined by bracket.**
Every other line carries timestamp + recipient, which reproduces it exactly via
`thread(filter: "skip <> <recipient>", since:, until:)`.

---

## A. What a layer is

**A1.** 2026-08-12 20:05:12 EDT → `app-fix-forward`, on snapping reaching the ribbon and the
document margin:

> it's not supposed to fucking cross layers, dude.

**A2.** 2026-08-12 20:09:44–20:10:08 EDT → `app-fix-forward`:

> can we just get someone to implement the fucking WM properly?
>
> But, like, can we also kick a fucking release candidate where we have a window manager that
> actually fucking works? The way it's fucking supposed to.
>
> Like, it actually has fucking layers.

**A3.** 2026-08-13 03:42:21 EDT → `app-fix-forward` — the invariant, in one sentence:

> the goal with that, right, was to, like, fix all the fucking seams where layers were just fake
> and shit could drift because it wasn't on the fucking layer it was in. Right? Like, shit can't
> like, we can't have coordinate frame bugs if things are in the right fucking coordinate frames.
> Like, we can have problems with one layer moving relative to the next, Wrong. But, like, shit in
> a layer stays in the fucking like, that's crucial.

**A4.** 2026-08-13 04:12:31–04:12:42 EDT → `app-fix-forward` — the model, asked as a question and
confirmed by the agent against `src/wm/viewport-coordinates.ts`:

> Like, the way I was thinking of this, like, layers have their own coordinate frame and their
> transforms.
>
> From one to the next. Yeah.
>
> Am I thinking of it wrong? Am I thinking of it what extent is that what is implemented?

**A5.** **id `2739253`** (exact, verified), 2026-08-13 04:17:06 EDT → `app-fix-forward`:

> Make layers fucking real. Like, that's what I'm saying, dude.

**A6.** 2026-08-13 04:17:35 EDT → `app-fix-forward`, immediately after:

> Like, if there are Right. So, clearly, a, literally everything has to use its own fucking
> coordinate, like the layer coordinate frame.

**A7.** 2026-08-13 04:17:59 EDT → `app-fix-forward` — on the two competing answers to "which
layer am I on" (a React context and the window manager's registry):

> And b like, Obviously, the React context and the window manager's registry have to agree

**A8.** 2026-08-13 03:49:21 EDT → `app-fix-forward`, on math notes being swept into panel
snapping — the membership rule stated as a rejection:

> That's not even the right fucking layer, dude.

**A9.** 2026-08-13 04:05:48–04:06:19 EDT → `app-fix-forward` — that this is general, not about
chat:

> Yes. The chat panel is legitimately on the hub [HUD] layer. Like, okay. The chat is on the
> Canvas as an implementation detail. I don't I've never seen one. I'm not supposed to ever
> fucking see one.
>
> I don't like, is it not true that we know what layer we're interacting with?
>
> And therefore like, I feel like this isn't about chat or anything.
>
> Right? Like, this is about being your fucking layer. Right?

---

## B. The layers UI

This is the half his 09-02 correction is about. It was settled with `chiefsoso` on 2026-08-15 and
restated to `sol-dev` on 2026-08-26.

**B1.** 2026-08-15 16:06:06 EDT → `chiefsoso` — he raises it as a window-manager-level question
and gives the constraint that moves happen in the common frame created by the relative transform:

> what is the UI for moving objects between layers? Like, clearly, since layers have, like, a
> relative position, right, the idea is, like, moves happen while the layer to layer relationship
> is like, the transforms are static, and they happen in that coordinate frame. So, you know, the
> common coordinate frame created by the relative transform. Right? But, like, but, like, yeah, on
> a UI level, are we gonna have, like, a little layers thing, a layers selector generally with
> like, a a move operation. It's kind of, like, general, or is it gonna be, like, per annotation?
> Or I I guess I'm just saying, like, where do we send them move to a different layer command

**B2.** 2026-08-15 16:15:04 EDT → `chiefsoso` — the resolution, his:

> I think think probably the move stuff should be, like, like selected object has a has a layer.
> Context, like, selected object is context for the layer menu, if that makes sense

He had just rejected the alternative the agent proposed (a per-object action menu), after the
agent conceded at 16:07:13 that no such menu exists: *"I made that up."*

**B3.** **id `2837246`** (exact, verified), 2026-08-15 16:15:53 EDT → `chiefsoso`:

> Exactly. And I guess we can expose, like, move and copy. Or will move always be a copy?

**B4.** 2026-08-15 16:17:23–16:17:29 EDT → `chiefsoso` — compositing, and why:

> And then, of course, right, like, I can composite multiple layers in my UI so it doesn't feel
> overwhelming. That's right. Right,
>
> Like, so I don't have to flick through a million fucking layers,

**B5.** **id `3363983`** (determined by bracket: id `3363982` = 02:08:48, id `3363984` = 02:08:52,
this message = 02:08:49), 2026-08-26 02:08:49 EDT → `sol-dev` — **the model named**:

> so loke in photoshop or whatever, you select any number of layers to be visible and one to be
> the currenr write target

**B6.** 2026-08-26 02:09:40–02:09:56 EDT → `sol-dev` — the same contextual menu, restated:

> and prob on selection the layer menu becomes a move-to-layer menu
>
> like if you have selected an annotation

**B7.** **id `3364033`** (exact, verified), 2026-08-26 02:10:14 EDT → `sol-dev` — **this is the
instruction his 09-02 correction says was misread**:

> btw there shlils be layer icons in the old presentation mode

---

## C. Write access and membership

**C1.** 2026-08-26 02:05:30–02:05:45 EDT → `sol-dev`, after being told the classroom UI routes all
student marks to a private overlay:

> the idea is anyone should be anle to write to any layer they have weite access to
>
> duse its supposed to be a spatial communication tool

**C2.** 2026-08-26 02:07:22 EDT → `sol-dev`:

> xommon means fucking common dude

**C3.** 2026-08-15 16:17:41–16:17:56 EDT → `chiefsoso` — the layer set he specified, confirmed by
him at 16:17:48 (*"So, like, the idea is students should have a layer that I don't have to
actually. Exactly,"*): student-private (student + their agent); student–instructor, one per
student (that student + him); common (everyone); his own private layer.

---

## D. Forward corrections — read these before acting on anything above

**D1. The shipped UI is not this.** 2026-09-02 03:44:19–03:45:47 EDT → `cleanup-chief`, ids
`3601729`–`3601791` (range supplied by cleanup-chief; the last, `3601791`, verified by direct
read):

> ps the layers ui is complete bullshit
>
> like
>
> it just isn't
>
> it's like
>
> 'draft mode'
>
> an old fucking thing
>
> so get me real fking layers please
>
> this was fuking specified
>
> ui, fking everything
>
> yeah, the draft mode layer icons were suppsoed to be borrowed; not the fking mode itself

**So B7 was an instruction to borrow the draft-mode *icons*. It was not an instruction to ship
draft mode, and draft mode is not the layers UI.**

**D2. He has asked what layers are three times since, and got no answer he accepted.**
2026-08-31 09:42:46 EDT → `sol-dev`: *"explain how layers are supposed to work?"*;
2026-08-31 10:00:17–10:00:24 EDT → `bhief-of-getting-shit-done`: *"and like the layer ui — where
the fuck is it. are layers a real thing"*; 10:01:04 EDT: *"i don't know what the fuck is going on
with layers"*.

**D3. The 08-27 commit that looks like the layers UI is not it.** `76fcbd9dc` (2026-08-27 18:59)
*"Presentation keeps the ordinary controls, and the layer selector is one of them"* is on `main`
and deployed on testing. **Per D1 the selector it preserves is draft mode.** A reader matching
that commit subject against his *"where was the layer selector?"* will mark this row done. It is
not done.

**D4. The layer model was reported by its own author as instrument-only, not seams-closed.**
2026-08-13 03:46:40 EDT, `wm-layers-rc` via `app-fix-forward`, in the agent's own words:

> It builds the instrument that makes a seam answerable. It does not close the seams. The WM can
> now say which layer a shape is in; almost nothing yet asks it.

Seams closed by that branch at that time: **zero, by the author's own count.**

**D5. Branch state now.** `work/qtm285-layers` (2026-08-31) carries two commits, neither on `main`
by subject: `ff1453ce1 Establish what the layer feature is, and why it is not on screen` and
`9dbdf85f1 Make the layers re-run a checklist rather than a rediscovery`. Both are records, not
implementation. `c9978e0f9 Compose classroom layers for the instructor` (08-31 21:27) **is** on
`main` and deployed on testing; it is the classroom compositing half of B4, and it is not the
layer menu of B2/B5/B6.

---

## E. What I did not establish

- **Whether a fuller written spec exists outside his thread.** He said *"this was fuking
  specified — ui, fking everything."* Everything above is from his thread. `docs/window-manager.md`
  exists and is the layer-model document, but it is agent-written and derived, so it is not
  evidence about what he asked for.
- **Exact ids for A1–A4, A6–A9, B1, B2, B4, B6, C1–C3, D2.** Timestamp + recipient is exact for
  all of them and reproduces each one directly.
