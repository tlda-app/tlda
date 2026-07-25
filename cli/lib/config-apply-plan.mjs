export function planLaunchdApply({ desiredJobs, existingJobs }) {
  const desired = new Map()
  for (const job of desiredJobs || []) {
    if (!job?.label) throw new Error('desired launchd job is missing label')
    if (!job?.plist) throw new Error(`desired launchd job ${job.label} is missing plist`)
    if (typeof job.content !== 'string') throw new Error(`desired launchd job ${job.label} is missing content`)
    desired.set(job.label, job)
  }

  const existing = new Map()
  for (const job of existingJobs || []) {
    if (!job?.label) continue
    existing.set(job.label, job)
  }

  const add = []
  const update = []
  const unchanged = []
  const remove = []

  for (const job of desired.values()) {
    const current = existing.get(job.label)
    if (!current) {
      add.push(job)
    } else if (current.content !== job.content || current.plist !== job.plist) {
      update.push({ ...job, previous: current })
    } else {
      unchanged.push(job)
    }
  }

  for (const job of existing.values()) {
    if (!desired.has(job.label)) remove.push(job)
  }

  return { add, update, unchanged, remove }
}

