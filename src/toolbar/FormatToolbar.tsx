/**
 * Custom toolbar that renders tools in the exact order specified by FormatConfig.
 *
 * TLDraw's DefaultToolbar/OverflowingToolbar reorders items internally.
 * This component bypasses that by using TldrawUiToolbar + TldrawUiToolbarButton
 * directly, driven by the config's `tools` array.
 */
import { useRef } from 'react'
import {
  useEditor,
  useValue,
  useTools,
  useIsToolSelected,
  TldrawUiToolbar,
  TldrawUiToolbarButton,
  TldrawUiButtonIcon,
  preventDefault,
} from 'tldraw'
import { getFormatConfig } from '../formatConfig'

export function FormatToolbar({ format }: { format?: string }) {
  const editor = useEditor()
  const tools = useTools()
  const activeToolId = useValue('current tool id', () => editor.getCurrentToolId(), [editor])
  const ref = useRef<HTMLDivElement>(null)
  const fmt = getFormatConfig(format)

  return (
    <div className="tlui-main-toolbar tlui-main-toolbar--vertical" ref={ref}>
      <div className="tlui-main-toolbar__inner">
        <div className="tlui-main-toolbar__left">
          <TldrawUiToolbar
            orientation="vertical"
            className="tlui-main-toolbar__tools"
            label="Tools"
          >
            {fmt.tools.map((toolId) => {
              const tool = tools[toolId]
              if (!tool) return null
              return (
                <ToolbarButton
                  key={toolId}
                  toolId={toolId}
                  tool={tool}
                  isActive={activeToolId === toolId}
                />
              )
            })}
          </TldrawUiToolbar>
        </div>
      </div>
    </div>
  )
}

function ToolbarButton({ toolId, tool, isActive }: {
  toolId: string
  tool: { id: string; icon: any; label: string; onSelect: (source: string) => void; kbd?: string }
  isActive: boolean
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
