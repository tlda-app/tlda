# The local layer

A window-manager primitive. Marking is its first consumer, not its owner.

## The primitive

Skip, 9/18:

> "yeah re the local name like, the idea of a layer that has a like local/transient coordinate frame is like...just generally a good idea. not saying we have other uses but like"

> "right like, this is a window manager. it has like, things with varying behaviors that should control their own frames when focused"

A local layer is a layer carrying its own transient coordinate frame, which the focused thing inside it controls. It belongs with the WM layer machinery, not inside a classroom component.

On the marking instance of it, his mechanics:

> "it is just a layer with a store and a frame and like, the understanding that it becomes active when the f***ing like, side by side soln/answer opens and like, that coordinate frame like, travels to the student with same anchoring/store swaps out per pair"

> "ink capture is this some weird thing? is it not just a layer on the canvas like any other?"

## Settled

- The name is "local".
- The local frame is a general WM primitive. Marking is the first use, not the definition.
- Teacher and student are one component differing only in access: *"THE STUDENT SHIT IS JUST THE F***ING TEACHER SHIT WITHOUT MULTIPLE STUDENTS"*, *"(+RO)"*.
- Return is a store copy, not access by reference: *"um i thought of like 'return marked problem' as a store copy..., not a store like, give access by rference"*.
- Marking ink is an ordinary layer in the same canvas, not a second canvas.

## Deliberately open

He specified no API shape and no hook-in point in the WM machinery. That is left to the implementer — a deliberate hole, not a gap.

## First consumer

Marking: the solution chapter with an instructor paging affordance, side-by-side solution/answer per student×problem, store swapped out per pair. Nothing in this document authorizes a second consumer.

## Ruled out

- Drawable glass in the app: *"if i wanted drawable used i'd f***ing say so. drawable is an affordance to have drawing on the static site. within the app it should do nothing at all."*
- Inventing further consumers: *"not saying we have other uses"*.
- Building on `src/classroom/StudentAnnotationOverlay.tsx`: the rejected separate-canvas predecessor. The local layer replaces it.
