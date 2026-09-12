# The human collaboration experience

tlda is designed for document-centered collaboration rather than code-editor-
centered interaction. The canvas keeps documents, annotations, chat, agents, and
source controls in one spatial workspace.

## Interaction modes

Core workflows support pointer, touch, and voice input. Keyboard commands are
optional accelerators, not prerequisites. A person reviewing from a tablet must
be able to navigate, annotate, converse, and inspect agent work without a
keyboard.

## Spatial continuity

Fleet chat and agent state remain beside the document. Moving between a
conversation and the passage it concerns should not require switching to a
separate application or reconstructing context from filenames and line numbers.

Chat filters may focus on one participant, but delegation and identity surfaces
must still make newly involved agents discoverable.

## Trustworthy feedback

Every consequential action needs a visible result:

- source edits show accepted, building, synchronized, conflict, or error state;
- agent lifecycle actions show the actual resulting identity and runtime state;
- message cards distinguish acceptance, notification delivery, and read state;
- long or paginated reads show their boundaries;
- failures remain visible until the user can act on them.

The browser-visible application is authoritative for browser behavior. Internal
logs and database rows support diagnosis but cannot replace checking the surface
the person uses.

## Attention and accessibility

The interface should keep context local, use stable spatial placement, and avoid
requiring a person to remember hidden state. Dense diagnostics belong behind
inspectable details rather than in the primary reading path.

Voice input can contain transcription errors and incomplete punctuation.
Interfaces should make correction cheap and preserve the original conversational
context rather than forcing precise command syntax for ordinary collaboration.

See also [The mirror principle](mirror-principle.md) and
[tlda as a collaboration medium](tlda-as-medium.md).
