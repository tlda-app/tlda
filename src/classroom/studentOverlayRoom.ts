// Where a student's own annotations live.
//
// The name is built in `shared/classroom-rooms.mjs` because the server parses
// what the client builds — it decides from this name whether a caller may enter
// the room at all. Two encodings that agree today are two that disagree after a
// rename, and the disagreement would show up as a student locked out of their
// own layer.
export { studentOverlayRoomId } from '../../shared/classroom-rooms.mjs'
