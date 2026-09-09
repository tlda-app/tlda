// Which permission grant a recovered runtime is bound under, and whether that
// question has an answer at all.
//
// The recovery path wrote `permission_grant: observed.permissionGrant || null`.
// With no ledger row there is no observed grant, so it wrote null -- and
// `recordProcess` persists the process fact before `bindSeat` ever looks at the
// grant, so the rejection landed after the write it should have prevented. The
// mint ended up with process state recorded, a null grant, and no join.
//
// There are exactly two authorities, in order:
//
//   1. the grant on a single coherent ledger binding for this runtime;
//   2. the compiled durable `launchRecipe.permissionGrant` on the same mint row.
//
// Nothing else. Not the retry flag, which says a human asked again and says
// nothing about permission. Not a profile default, which would answer the
// question by inventing an authority rather than finding one. A grant that
// cannot be traced to one of the two is a grant nobody issued.
//
// Disagreement refuses. Two authorities that do not say the same thing is not a
// tie to break -- it is the case where writing either one binds an agent under
// permissions its own record contradicts.

export const PERMISSION_AUTHORITY_LEDGER = 'ledger-binding'
export const PERMISSION_AUTHORITY_RECIPE = 'launch-recipe'

function sameGrant(left, right) {
  if (typeof left === 'string' || typeof right === 'string') return left === right
  const leftProfiles = [...new Set(left?.profiles || [])].sort()
  const rightProfiles = [...new Set(right?.profiles || [])].sort()
  return left?.type === right?.type
    && leftProfiles.length === rightProfiles.length
    && leftProfiles.every((name, index) => name === rightProfiles[index])
}

// `normalizeGrant` throws for a grant naming a profile this daemon has no
// configuration for. That throw is the "invalid or unconfigured" test, and it
// is a refusal rather than a fallback: a recipe pointing at a profile that no
// longer exists is a recipe whose intent cannot be honoured, and quietly
// resolving it to something else would grant permissions nobody chose.
export function resolvePartialMintPermissionAuthority({
  ledgerGrant = null,
  ledgerBindsSingleRuntime = false,
  recipeGrant = null,
  normalizeGrant,
} = {}) {
  const normalize = (grant, source) => {
    if (grant === null || grant === undefined) return { present: false, grant: null }
    try {
      return { present: true, grant: normalizeGrant(grant) }
    } catch (error) {
      return { present: true, invalid: true, source, detail: error?.message || String(error) }
    }
  }

  const ledger = normalize(ledgerGrant, PERMISSION_AUTHORITY_LEDGER)
  const recipe = normalize(recipeGrant, PERMISSION_AUTHORITY_RECIPE)

  if (ledger.invalid) {
    return { ok: false, reason: 'ledger-grant-invalid', detail: ledger.detail }
  }
  if (recipe.invalid) {
    return { ok: false, reason: 'recipe-grant-invalid', detail: recipe.detail }
  }

  // Existence is what creates a disagreement, not admissibility. An incoherent
  // ledger row may not be USED as the authority, but a grant recorded on it
  // that contradicts the recipe still means the two records of this agent's
  // permissions do not agree, and that is not something to write through.
  if (ledger.present && recipe.present && !sameGrant(ledger.grant, recipe.grant)) {
    return {
      ok: false,
      reason: 'grant-authority-disagreement',
      ledgerGrant: ledger.grant,
      recipeGrant: recipe.grant,
    }
  }

  if (ledger.present) {
    if (ledgerBindsSingleRuntime) {
      return { ok: true, grant: ledger.grant, source: PERMISSION_AUTHORITY_LEDGER }
    }
    // The row does not coherently bind this one runtime, so it cannot speak for
    // it. The recipe can, and by here it agrees with the row.
    if (recipe.present) {
      return { ok: true, grant: recipe.grant, source: PERMISSION_AUTHORITY_RECIPE }
    }
    return { ok: false, reason: 'ledger-binding-not-coherent' }
  }

  if (recipe.present) {
    return { ok: true, grant: recipe.grant, source: PERMISSION_AUTHORITY_RECIPE }
  }

  return { ok: false, reason: 'no-grant-authority' }
}
