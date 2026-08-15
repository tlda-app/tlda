export function fleetLayoutDx(variant: string, ownerDx: number): number {
  return variant === 'both-margins' ? 0 : ownerDx
}
