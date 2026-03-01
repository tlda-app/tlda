# Presenter/Viewer Roles

tlda supports two roles for collaborative annotation sessions: **presenter** and **viewer**. The role determines which controls you see and how camera sync works.

## Roles

### Presenter

- Broadcasts camera position — all viewers follow automatically
- Sees the **visibility pill** (top-left): cycle between visible / faint / hidden to control how much viewer annotations distract you
- Shapes created by the presenter sync immediately (no draft layer)
- Last presenter wins — if two people claim presenter, the most recent one's camera is followed

### Viewer

- Follows the presenter's camera automatically (shows "Following" badge)
- Sees the **draft pill** (top-left): shows count of unpublished drafts
- All shapes created by the viewer start as **drafts** — visible only to you at 45% opacity until published
- Can publish drafts individually or in bulk via the draft pill

## Setting Your Role

Toggle between roles in the **Table of Contents** panel (the role toggle appears at the bottom). Click to switch:

- "Presenting" — you're the presenter
- "Viewing" — you're a viewer

The role persists per document in `localStorage`.

## Token-Gated Access

When authentication is enabled, tokens determine who can present:

- **RW token** holders can toggle between presenter and viewer
- **Read token** holders are locked to viewer (the toggle is hidden)
- **No auth** (default): everyone can toggle freely

Enable auth by setting `TLDA_TOKEN_RW` and/or `TLDA_TOKEN_READ` environment variables when starting the server, or via `tlda config set tokenRw <token>` and `tlda config set tokenRead <token>`.

Share a read-only viewer URL with `tlda share <name>`.

## Draft Annotation Layer

When you're a viewer, every shape you create (notes, pen strokes, highlights, arrows) starts as a draft:

- Drafts are visible only to you, rendered at 45% opacity with a subtle dashed outline
- Other viewers and the presenter don't see your drafts
- The **draft pill** in the top-left shows your draft count

### Publishing

- **Publish all**: click the draft pill, then "Publish all N"
- **Publish selected**: select specific shapes, then click the draft pill — it shows "Publish N selected"
- **Publish individual notes**: each math note has a "Publish" button when it's a draft

Published shapes become visible to everyone immediately.

## Visibility Modes (Presenter)

The presenter's visibility pill cycles through three modes:

| Mode | Effect |
|------|--------|
| **Visible** | All annotations shown normally |
| **Faint** | Viewer annotations dimmed to ~7% opacity |
| **Hidden** | Viewer annotations invisible |

This lets the presenter reduce visual noise during a presentation without deleting annotations.

## Camera Sync

Camera sync is automatic and role-driven:

- **Presenter**: always broadcasts camera position. Scrolling, zooming, or navigating pages sends the position to all viewers.
- **Viewer**: always follows the presenter's broadcast. A "Following" badge appears when a presenter is active.

There's no manual camera link toggle — the role handles it.

## Presenter Signal

The presenter broadcasts a `signal:presenter` that persists for 10 minutes. This means:
- Late-joining viewers automatically follow the presenter
- If the presenter's tab closes, viewers stop following after 10 minutes
- Only one presenter signal is active at a time (last one wins)
