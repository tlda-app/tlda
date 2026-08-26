// Where a student's own annotations live.
//
// The book's room is the layer the whole class shares; this names the room that
// holds one student's marks over it. Derived from the book's room rather than
// stored anywhere: the overlay is a coordinate on a book the caller already
// named, the same way AGENTS.md reads `eiv-paper@0b77278` — so there is nothing
// to keep in step and nothing to reconcile if a book is renamed.
export function studentOverlayRoomId(bookRoomId: string, studentId: string): string {
  return `${bookRoomId}::student::${studentId}`
}
