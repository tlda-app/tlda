import { createAppRecordingOwner } from './appRecordingOwner'

const opened: string[] = []
let exits = 0
const owner = createAppRecordingOwner((doc) => {
  opened.push(doc)
  return () => { exits += 1 }
})

owner.observe('project-a', true)
owner.observe('project-b', true)
owner.observe('book-member-c', true)
if (opened.length !== 1 || opened[0] !== 'project-a') throw new Error('navigation restarted the app-owned recording envelope')
if (exits !== 0) throw new Error('navigation finalized the app-owned recording envelope')
owner.exit()
if (Number(exits) !== 1) throw new Error('app exit did not finalize exactly once')
console.log('app navigation retains one recording envelope: PASS')
