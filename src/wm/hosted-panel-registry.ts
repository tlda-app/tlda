export type HostedPanelSize = {
  w: number
  h: number
}

export type HostedPanelAppDefinition<TType extends string = string> = {
  type: TType
  defaultSize: HostedPanelSize
  defaultProps?: Record<string, unknown>
}

export function defineHostedPanelApps<const TDefinitions extends readonly HostedPanelAppDefinition<string>[]>(
  definitions: TDefinitions,
): TDefinitions {
  return definitions
}

export function hostedPanelAppMap<TType extends string, TDefinition extends HostedPanelAppDefinition<TType>>(
  definitions: readonly TDefinition[],
): ReadonlyMap<TType, TDefinition> {
  return new Map(definitions.map(definition => [definition.type, definition]))
}

export function hostedPanelSizeMap<TType extends string>(
  definitions: readonly HostedPanelAppDefinition<TType>[],
): Record<TType, HostedPanelSize> {
  return Object.fromEntries(definitions.map(definition => [definition.type, definition.defaultSize])) as Record<TType, HostedPanelSize>
}

export function hostedPanelDefaultProps<TType extends string>(
  registry: ReadonlyMap<TType, HostedPanelAppDefinition<TType>>,
  type: string,
): Record<string, unknown> {
  return { ...(registry.get(type as TType)?.defaultProps ?? {}) }
}
