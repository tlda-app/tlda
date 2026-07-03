# Phone pane-stack — design spec (draft for Skip's red-line)

## The idea in one line

On the phone, the **inbox is a list of tasks** (openable objects). **Flick a task left to pin it** as a full-page locked pane on a horizontal **stack**. Everything — create, navigate, close — is a gesture; **no buttons**.

## Concept {#concept}

- The **inbox** is the second column: a list of *openable objects* — chat threads, math notes, doc refs, any object type. Think of it as a **list of tasks**.
- **Tapping** a task **opens it in place** inside the inbox shape (a chat opens as a chat with the usual filter overlay; a note opens as the note). Tap **back** → back to the list. This is lightweight/ephemeral — nothing is created.
- To keep it, you **flick it left** — it **ejects out of the inbox** and becomes a **full-page locked pane** on the stack. Now you have a whole page for it instead of being cramped in the inbox. This is "pinning the task."
- The result is a **stack of panes** you page through. Panes are the existing fleet-panel lanes, generalized: one pane = one full-page locked object.

## Gestures — one language {#gestures}

All create/navigate/destroy speak the **same fill-the-arrow-past-threshold** language we built for lane transitions (big center arrow, ~75%-of-screen deliberate swipe). Short swipes / normal scrolling never trigger anything, because you must be **at the relevant edge** and cross the **full threshold**.

1. **Page (left / right)** — move between panes that already exist on the stack. Safe: never creates or destroys anything.
2. **Push / flick-out (left, from an object open in the inbox)** — ejects the in-place open object out of the inbox into its own full-page locked pane on the stack. This is the *only* create primitive.
3. **Delete (down, past the bottom of a pane)** — scroll the pane normally; at the bottom, keep pulling **down** (overscroll), the arrow fills, cross the threshold → the pane closes. Arrow at **full prominence** (overscroll-at-bottom is already a deliberate/weird motion, so no false triggers — no need to make it subtle).

## Inbox states {#inbox-states}

The inbox shape is one of three states:
- **List** (default): the task list.
- **Open-in-place**: a tapped task is shown open *inside* the inbox shape (chat + filter overlay, note, etc.). Back → List.
- **Ejecting**: a left flick past threshold on the open object promotes it out → a new stack pane; the inbox returns to **List**.

## Terminal hover on phone {#terminal-hover}

The terminal hover normally drops **downward** from a chat message — but on phone, downward is now the **delete** gesture, so that's a conflict (and there's no real hover on touch anyway).

**Decision (Skip):** on phone, the terminal hover **drops down from the TOP** and occupies the **top half of the screen**. (The alternative — pushing the chat up to make room — is rejected; drop-from-top is easier and cleaner.)

## Layout & data model {#data-model}

Decided with Skip:

- **The document is a FIXED pane** — the anchor. This is a document-based app; the doc is always there, never itself pinned/created/destroyed.
- **No dedicated chat lane.** *Every* chat is a **pinned-from-inbox pane**. The default layout is just **document + inbox** — you have no chats until you pin one.
- **Pinning pushes onto the stack going left**: flicking a task left mints its pane and **pushes everything left** (the new pane enters and the stack shifts). So the newest pinned pane is adjacent to the inbox and older ones shift away.

Structure:
- A **pane stack**: fixed **document** pane + **inbox** pane + zero-or-more **pinned panes** (full-page **locked** objects), growing leftward as you pin. The **top (newest) pinned pane sits next to the inbox**; older panes shift away.
- Paging L/R = moving the current-pane index across the stack (reuses the drift-proof lane-index we shipped).
- **Persistence:** the stack **survives reload like any other layout choice** — it's persisted the same way layout presets are, so your pinned panes come back.

## Agents panel = the chat composer {#agents-panel}

The agents panel is **not** a lane and not a pinnable object — it's how you **compose a new chat from scratch** (the other way a task is born, alongside pinning an existing thread).

- The **inbox goes full-page** (no separate agents lane above it).
- The agents panel is a **sticky footer** on the inbox — an element that lives in the inbox but **does not scroll off the bottom**.
- **Tapping the footer** opens a **~¾-screen-tall agents panel** plus a **small empty chat**. You **filter that empty chat with the normal filter overlay** — that's how you pick who/what it targets. (Literally just a fresh empty chat you filter.)
- An **"assign"** button ("pin" isn't quite the word) turns the constructed chat into a **task** — pushed onto the stack, same as a pinned thread.

**Two births, one destination:** a task/pane comes from either **pinning an existing inbox thread** (flick-left) or **composing one** (footer → empty chat → filter → assign). Both end as full-page locked panes on the stack.

## Non-goals / preserved

- Desktop is untouched — this is phone-only.
- Reuses the shipped gesture engine (fill-arrow, 75% threshold, drift-proof lane index) — not a new gesture system.
