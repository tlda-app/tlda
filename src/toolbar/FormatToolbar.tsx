/**
 * Custom toolbar that renders tools in the exact order specified by FormatConfig,
 * with TLDraw's DefaultToolbar handling overflow/collapse when there isn't enough height.
 */
import {
  useTools,
  useIsToolSelected,
  DefaultToolbar,
  TldrawUiToolbarButton,
  TldrawUiButtonIcon,
  preventDefault,
} from 'tldraw'
import { getFormatConfig } from '../formatConfig'

export function FormatToolbar({ format }: { format?: string }) {
  const tools = useTools()
  const fmt = getFormatConfig(format)

  return (
    <DefaultToolbar
      orientation="vertical"
      minItems={4}
      maxItems={8}
      minSizePx={200}
      maxSizePx={700}
    >
      {fmt.tools.map((toolId) => {
        const tool = tools[toolId]
        if (!tool) return null
        return (
          <ToolbarButton
            key={toolId}
            toolId={toolId}
            tool={tool}
          />
        )
      })}
    </DefaultToolbar>
  )
}

function ToolbarButton({ toolId, tool }: {
  toolId: string
  tool: { id: string; icon: any; label: string; onSelect: (source: any) => void; kbd?: string }
}) {
  const isSelected = useIsToolSelected(tool)
  return (
    <TldrawUiToolbarButton
      data-testid={`tools.${toolId}`}
      data-value={toolId}
      aria-pressed={isSelected ? 'true' : 'false'}
      type="tool"
      title={tool.label}
      onClick={() => tool.onSelect('toolbar')}
      onTouchStart={(e) => {
        preventDefault(e)
        tool.onSelect('toolbar')
      }}
    >
      <TldrawUiButtonIcon icon={tool.icon} />
    </TldrawUiToolbarButton>
  )
}
