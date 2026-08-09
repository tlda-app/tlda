export function isOwnerCapableLaunchdManager(managerName) {
  return String(managerName || '').trim() === 'Aqua'
}

export function assertOwnerCapableLaunchdManager(managerName) {
  if (isOwnerCapableLaunchdManager(managerName)) return
  throw new Error('configuration is not applied: launchd configuration requires the owner GUI context')
}

/**
 * Apply one already-validated launchd job transition. The caller owns atomic
 * plist installation; this function owns service-state rollback.
 */
export async function transitionLaunchdJob(job, operation, {
  install,
  remove,
  bootout,
  bootstrap,
}) {
  const previous = operation === 'remove' ? job : (job.previous || null)

  try {
    if (operation === 'add') {
      await install(job)
      await bootstrap(job)
    } else if (operation === 'update') {
      await install(job)
      await bootout(job)
      await bootstrap(job)
    } else if (operation === 'remove') {
      await bootout(job)
      await remove(job)
    } else {
      throw new Error(`unknown launchd apply operation: ${operation}`)
    }
    return { ok: true }
  } catch (error) {
    try {
      if (operation === 'add') {
        await bootout(job)
        if (previous) await install(previous)
        else await remove(job)
        if (previous?.loaded) await bootstrap(previous)
      } else if (operation === 'update') {
        await bootout(job)
        if (!previous) throw new Error(`missing previous launchd job for ${job.label}`)
        await install(previous)
        await bootstrap(previous)
      } else if (operation === 'remove') {
        await install(previous)
        if (previous?.loaded) await bootstrap(previous)
      }
    } catch (rollbackError) {
      throw new Error(
        `${error?.message || String(error)}; rollback failed: ${rollbackError?.message || String(rollbackError)}`,
      )
    }
    throw error
  }
}
