import { spawn } from 'node:child_process'

process.on('message', message => {
  if (message?.t !== 'build') return
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process')
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    if (process.send) process.send({ grandchild: grandchild.pid })
    setInterval(() => {}, 1000)
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  child.on('message', ({ grandchild }) => {
    process.send?.({ t: 'tree', worker: process.pid, child: child.pid, grandchild })
  })
})
