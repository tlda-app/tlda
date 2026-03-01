import React, { useState, useEffect, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { 
  Tldraw, 
  Editor, 
  TLComponents,
  DefaultToolbar,
  TldrawUiMenuItem,
  useTools,
  useEditor,
  useValue,
  DefaultColorStyle,
  DefaultStylePanel,
  AssetRecordType,
} from 'tldraw'
import 'tldraw/tldraw.css'
import './overrides.css'

interface DrawableOptions {
  persist?: boolean
  id?: string
  syncCamera?: boolean  // Enable camera sync with underlying image
  targetSelector?: string  // Selector for the image/svg to sync with
  scrolly?: boolean  // Is this a scrolly (image-toggle)?
  scrollyContainer?: HTMLElement  // The image-toggle container
}

// Color button that shows current color and toggles style panel
function ColorPickerButton({ isOpen, onToggle }: { isOpen: boolean, onToggle: () => void }) {
  const editor = useEditor()
  const color = useValue('color', () => {
    const style = editor.getSharedStyles().get(DefaultColorStyle)
    return style?.type === 'shared' ? style.value : 'black'
  }, [editor])
  
  const colorMap: Record<string, string> = {
    black: '#1d1d1d',
    grey: '#9ea4aa', 
    red: '#e03131',
    orange: '#ff922b',
    yellow: '#ffc034',
    green: '#099268',
    blue: '#4263eb',
    violet: '#ae3ec9',
    white: '#ffffff',
    'light-violet': '#e599f7',
    'light-blue': '#a5d8ff',
    'light-green': '#69db7c',
    'light-yellow': '#ffe066',
    'light-red': '#ffa8a8',
  }
  
  return (
    <button
      className={`drawable-color-button ${isOpen ? 'active' : ''}`}
      onClick={onToggle}
      title="Color & Style"
    >
      <span 
        className="drawable-color-swatch" 
        style={{ background: colorMap[color] || '#1d1d1d' }}
      />
    </button>
  )
}

// Custom toolbar
function DrawableToolbar({ styleOpen, setStyleOpen }: { styleOpen: boolean, setStyleOpen: (v: boolean) => void }) {
  const tools = useTools()
  const toolsToShow = ['select', 'hand', 'draw', 'eraser', 'highlight', 'arrow', 'text']
  
  return (
    <DefaultToolbar>
      {toolsToShow.map(toolId => {
        const tool = tools[toolId]
        if (!tool) return null
        return <TldrawUiMenuItem key={toolId} {...tool} />
      })}
      <ColorPickerButton isOpen={styleOpen} onToggle={() => setStyleOpen(!styleOpen)} />
    </DefaultToolbar>
  )
}

function ToggleableStylePanel({ isOpen }: { isOpen: boolean }) {
  if (!isOpen) return null
  return <DefaultStylePanel />
}

// Convert SVG element to data URL
function svgToDataUrl(svg: SVGSVGElement): string {
  const serializer = new XMLSerializer()
  const svgString = serializer.serializeToString(svg)
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgString)))
}

// Add image to TLDraw canvas (returns shape id)
function addImageToEditor(editor: Editor, target: HTMLElement, index: number = 0): string | null {
  let dataUrl: string
  let width: number
  let height: number
  
  if (target instanceof SVGSVGElement) {
    dataUrl = svgToDataUrl(target)
    const bbox = target.getBoundingClientRect()
    width = bbox.width
    height = bbox.height
  } else if (target instanceof HTMLImageElement) {
    dataUrl = target.src
    width = target.naturalWidth || target.width
    height = target.naturalHeight || target.height
  } else {
    return null
  }
  
  const assetId = AssetRecordType.createId()
  
  editor.createAssets([{
    id: assetId,
    type: 'image',
    typeName: 'asset',
    props: {
      name: `plot-${index}`,
      src: dataUrl,
      w: width,
      h: height,
      mimeType: 'image/svg+xml',
      isAnimated: false,
    },
    meta: {},
  }])
  
  const shapeId = `shape:image-${index}` as any
  editor.createShape({
    id: shapeId,
    type: 'image',
    x: 0,
    y: 0,
    isLocked: false,
    meta: {
      hidden: index !== 0,  // Hide all but first
    },
    props: {
      assetId,
      w: width,
      h: height,
    },
  })
  
  return shapeId
}

// Add all images from scrolly cells to TLDraw
function addScrollyImagesToEditor(editor: Editor, container: HTMLElement): string[] {
  const shapeIds: string[] = []
  
  // Find all cells in the image-toggle
  const cells = container.querySelectorAll('.image-toggle-cell')
  
  cells.forEach((cell, index) => {
    const svg = cell.querySelector('svg')
    const img = cell.querySelector('img')
    const target = svg || img
    
    if (target) {
      const shapeId = addImageToEditor(editor, target as HTMLElement, index)
      if (shapeId) {
        shapeIds.push(shapeId)
        // Hide original
        ;(target as HTMLElement).style.visibility = 'hidden'
      }
    }
  })
  
  return shapeIds
}

// Map to store shape IDs for each drawable
const scrollyShapeIds = new Map<string, string[]>()

// Track current visible index per drawable
const currentVisibleIndex = new Map<string, number>()

// Show specific image in scrolly (hide others)
export function showScrollyImage(id: string, index: number) {
  const prevIndex = currentVisibleIndex.get(id)
  if (prevIndex === index) return // No change
  
  const editor = editorRefs.get(id)
  const shapeIds = scrollyShapeIds.get(id)
  if (!editor || !shapeIds) return
  
  currentVisibleIndex.set(id, index)
  
  // Update meta.hidden on each shape
  const updates = shapeIds.map((shapeId, i) => ({
    id: shapeId as any,
    type: 'image' as const,
    meta: {
      hidden: i !== index,
    },
  }))
  editor.updateShapes(updates)
}

// Wrapper component
function DrawableApp({ 
  persist, 
  id, 
  syncCamera, 
  targetElement,
  scrolly,
  scrollyContainer,
  onEditorMount,
}: { 
  persist: boolean
  id: string
  syncCamera: boolean
  targetElement: HTMLElement | null
  scrolly: boolean
  scrollyContainer: HTMLElement | null
  onEditorMount?: (editor: Editor) => void
}) {
  const [styleOpen, setStyleOpen] = useState(false)
  
  const components: TLComponents = {
    Toolbar: () => <DrawableToolbar styleOpen={styleOpen} setStyleOpen={setStyleOpen} />,
    StylePanel: () => <ToggleableStylePanel isOpen={styleOpen} />,
    PageMenu: null,
    MainMenu: null,
    NavigationPanel: null,
    HelpMenu: null,
    DebugMenu: null,
    SharePanel: null,
    MenuPanel: null,
    TopPanel: null,
    HelperButtons: null,
    ActionsMenu: null,
    QuickActions: null,
    KeyboardShortcutsDialog: null,
    ZoomMenu: null,
  }
  
  return (
    <Tldraw
      persistenceKey={persist ? id : undefined}
      components={components}
      getShapeVisibility={(shape) => shape.meta?.hidden ? 'hidden' : 'inherit'}
      onMount={(editor: Editor) => {
        editor.setCurrentTool('draw')
        editor.updateInstanceState({ exportBackground: false })
        
        // Register editor for external control first
        if (onEditorMount) {
          onEditorMount(editor)
        }
        
        // Handle scrolly mode - add all images from the stack
        if (scrolly && scrollyContainer) {
          const shapeIds = addScrollyImagesToEditor(editor, scrollyContainer)
          scrollyShapeIds.set(id, shapeIds)
          
          // Prevent deleting the background images
          editor.sideEffects.registerBeforeDeleteHandler('shape', (shape) => {
            if (shape.type === 'image' && shapeIds.includes(shape.id)) {
              return false // Prevent deletion
            }
            return // Allow other deletions
          })
          
          // Set up observer to watch for active cell changes
          const observer = new MutationObserver(() => {
            const cells = scrollyContainer.querySelectorAll('.image-toggle-cell')
            cells.forEach((cell, index) => {
              if (cell.classList.contains('active')) {
                showScrollyImage(id, index)
              }
            })
          })
          
          // Observe the stack for class changes
          const stack = scrollyContainer.querySelector('.image-toggle-stack')
          if (stack) {
            observer.observe(stack, { subtree: true, attributes: true, attributeFilter: ['class'] })
          }
        }
        // Add single image if syncCamera is enabled (non-scrolly)
        else if (syncCamera && targetElement) {
          addImageToEditor(editor, targetElement)
          // Hide the original
          targetElement.style.visibility = 'hidden'
        }
        
        // Set camera to origin with zoom 1
        editor.setCamera({ x: 0, y: 0, z: 1 })
        
        // If syncCamera or scrolly, enable camera; otherwise lock it
        if (syncCamera || scrolly) {
          editor.setCameraOptions({
            isLocked: false,
            wheelBehavior: 'zoom',
            panSpeed: 1,
            zoomSpeed: 1,
          })
        } else {
          editor.setCameraOptions({
            isLocked: true,
            wheelBehavior: 'none',
            panSpeed: 0,
            zoomSpeed: 0,
          })
        }
      }}
    >
    </Tldraw>
  )
}

// Store editor references for external control
const editorRefs = new Map<string, Editor>()

// Linked camera groups: group name -> set of drawable IDs
const linkedGroups = new Map<string, Set<string>>()

// Track which group each drawable belongs to
const drawableToGroup = new Map<string, string>()

// Flag to prevent infinite camera sync loops
let syncingCamera = false

// Sync camera from one drawable to all others in its group
function syncCameraToGroup(sourceId: string, camera: { x: number, y: number, z: number }) {
  if (syncingCamera) return
  
  const groupName = drawableToGroup.get(sourceId)
  if (!groupName) return
  
  const group = linkedGroups.get(groupName)
  if (!group) return
  
  syncingCamera = true
  group.forEach(id => {
    if (id !== sourceId) {
      const editor = editorRefs.get(id)
      if (editor) {
        editor.setCamera(camera)
      }
    }
  })
  syncingCamera = false
}

// Register a drawable in a linked group
export function registerLinkedCamera(id: string, groupName: string) {
  // Add to group
  if (!linkedGroups.has(groupName)) {
    linkedGroups.set(groupName, new Set())
  }
  linkedGroups.get(groupName)!.add(id)
  drawableToGroup.set(id, groupName)
  
  // Set up camera change listener (with retry if editor not ready)
  function setupListener() {
    const editor = editorRefs.get(id)
    if (!editor) {
      // Retry after a short delay
      setTimeout(setupListener, 50)
      return
    }
    
    editor.store.listen(({ changes }) => {
      if (syncingCamera) return
      // Check if camera changed
      for (const [_, to] of Object.values(changes.updated)) {
        if ((to as any).typeName === 'camera') {
          const camera = editor.getCamera()
          syncCameraToGroup(id, camera)
          break
        }
      }
    })
  }
  
  setupListener()
}

// Mount tldraw into a container
export function mount(container: HTMLElement, options: DrawableOptions = {}) {
  const { 
    persist = false, 
    id = 'drawable-' + Math.random().toString(36).slice(2, 10),
    syncCamera = false,
    targetSelector = 'img, svg',
    scrolly = false,
    scrollyContainer = null,
  } = options
  
  // Find the target element to sync camera with
  let targetElement: HTMLElement | null = null
  if (syncCamera && !scrolly) {
    // Look in the parent wrapper for the content
    const wrapper = container.closest('.drawable-wrapper')
    if (wrapper) {
      const content = wrapper.querySelector('.drawable-content')
      if (content) {
        targetElement = content.querySelector(targetSelector) as HTMLElement
      }
    }
    // For linked-cameras, the overlay is a sibling of the image, not inside a wrapper
    if (!targetElement) {
      const parent = container.parentElement
      if (parent) {
        targetElement = parent.querySelector(targetSelector) as HTMLElement
      }
    }
  }
  
  const root = ReactDOM.createRoot(container)
  root.render(
    <DrawableApp 
      persist={persist} 
      id={id} 
      syncCamera={syncCamera}
      targetElement={targetElement}
      scrolly={scrolly}
      scrollyContainer={scrollyContainer}
      onEditorMount={(editor) => editorRefs.set(id, editor)}
    />
  )
  
  return {
    unmount: () => {
      editorRefs.delete(id)
      root.unmount()
    }
  }
}

// Enable/disable camera controls for a specific drawable
export function setCameraActive(id: string, active: boolean) {
  const editor = editorRefs.get(id)
  if (!editor) return
  
  if (active) {
    editor.setCameraOptions({
      isLocked: false,
      wheelBehavior: 'zoom',
      panSpeed: 1,
      zoomSpeed: 1,
    })
  } else {
    editor.setCameraOptions({
      isLocked: true,
      wheelBehavior: 'none',
      panSpeed: 0,
      zoomSpeed: 0,
    })
  }
}

// Enable/disable drawing mode (shows/hides toolbar, enables/disables pointer events)
export function setDrawingMode(id: string, active: boolean) {
  const editor = editorRefs.get(id)
  const overlay = document.getElementById(id)
  if (!editor || !overlay) return
  
  if (active) {
    overlay.style.pointerEvents = 'auto'
    // Small delay to ensure TLDraw has fully rendered before adding class
    setTimeout(() => {
      overlay.classList.add('drawing-active')
    }, 50)
    editor.setCurrentTool('draw')
  } else {
    overlay.style.pointerEvents = 'none'
    overlay.classList.remove('drawing-active')
    editor.setCurrentTool('select')
  }
}

// Reset camera to origin
export function resetCamera(id: string) {
  const editor = editorRefs.get(id)
  if (!editor) return
  editor.setCamera({ x: 0, y: 0, z: 1 })
}

// Auto-init for elements with data-drawable attribute
function init() {
  document.querySelectorAll('[data-drawable]').forEach((el) => {
    if (el instanceof HTMLElement && !el.dataset.drawableInit) {
      el.dataset.drawableInit = 'true'
      mount(el, {
        persist: el.dataset.persist === 'true',
        id: el.dataset.drawableId || el.id,
        syncCamera: el.dataset.syncCamera === 'true',
      })
    }
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

export default { mount, setCameraActive, setDrawingMode, resetCamera, registerLinkedCamera }
