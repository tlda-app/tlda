-- drawable.lua
-- Embeds TLDraw canvas for drawing on figures
-- Automatically wraps all figures, or manually via ::: {.drawable}
-- Also inlines SVGs for drawable figures (so TLDraw can access them)

io.stderr:write("DRAWABLE FILTER LOADED\n")

local script_added = false

-- Track if we're inside a drawable context
local drawable_context_depth = 0

---Split a string by character sequence.
local function split(str, chars)
  local parts = {}
  for line in str:gmatch("[^" .. chars .. "]+") do
    table.insert(parts, line)
  end
  return parts
end

---Read an entire file.
local function read_file(path)
  local fh = assert(io.open(path, "rb"))
  local contents = assert(fh:read(_VERSION <= "Lua 5.2" and "*a" or "a"))
  fh:close()
  return contents
end

---Read an SVG file and return it as inline HTML
local function read_svg(path)
  local svg_content = read_file(path)
  local svg_lines = split(svg_content, "\r\n")
  -- remove the XML header if present
  if svg_lines[1] and svg_lines[1]:match("^<%?xml") then
    table.remove(svg_lines, 1)
  end
  -- remove 'pt' units from width and height
  if svg_lines[1] then
    svg_lines[1] = string.gsub(svg_lines[1], '(%d+[.]?%d*)pt', '%1')
  end
  return table.concat(svg_lines, "\n")
end

-- Add dependencies
if quarto and quarto.doc then
  local js_path = quarto.utils.resolve_path("drawable.js")
  local css_path = quarto.utils.resolve_path("drawable.css")
  
  quarto.doc.add_html_dependency({
    name = "drawable-tldraw",
    version = "1.0.0",
    scripts = {js_path},
    stylesheets = {css_path}
  })
end

-- Generate the toggle script (only once per document)
local function get_script()
  if script_added then
    return ""
  end
  script_added = true
  return [[
<script>
function toggleDrawable(id) {
  var overlay = document.getElementById(id);
  var btn = overlay.nextElementSibling;
  var resetBtn = overlay.resetBtn;
  
  // Lazy init on first click
  if (!overlay.dataset.drawableInit) {
    initDrawable(id);
  }
  
  var isDrawing = overlay.dataset.drawing === 'true';
  var syncCamera = overlay.dataset.syncCamera === 'true';
  if (!isDrawing) {
    // Enable drawing mode
    overlay.dataset.drawing = 'true';
    overlay.style.pointerEvents = 'auto';
    btn.textContent = '✕';
    if (resetBtn) {
      resetBtn.style.pointerEvents = 'auto';
    }
    // Add drawing-active class after a delay to let TLDraw mount
    setTimeout(function() {
      overlay.classList.add('drawing-active');
    }, 100);
    Drawable.setDrawingMode(id, true);
    if (syncCamera) {
      Drawable.setCameraActive(id, true);
    }
  } else {
    // Disable drawing mode (but keep canvas visible)
    overlay.dataset.drawing = 'false';
    overlay.style.pointerEvents = 'none';
    overlay.classList.remove('drawing-active');
    btn.textContent = '✏️';
    if (resetBtn) {
      resetBtn.style.pointerEvents = 'none';
    }
    Drawable.setDrawingMode(id, false);
    if (syncCamera) {
      Drawable.setCameraActive(id, false);
    }
  }
}

// Initialize drawable lazily when first clicked
function initDrawable(id) {
  var overlay = document.getElementById(id);
  if (!overlay || overlay.dataset.drawableInit) return;
  
  var syncCamera = overlay.dataset.syncCamera === 'true';
  var isScrolly = overlay.dataset.scrolly === 'true';
  overlay.dataset.drawableInit = 'true';
  overlay.dataset.drawing = 'false';
  
  // For scrolly, find the image-toggle container
  var scrollyContainer = null;
  if (isScrolly) {
    var figureCol = overlay.closest('.image-toggle-figure');
    scrollyContainer = figureCol?.querySelector('.image-toggle');
  }
  
  Drawable.mount(overlay, { 
    persist: overlay.dataset.persist === 'true', 
    id: id,
    syncCamera: syncCamera,
    scrolly: isScrolly,
    scrollyContainer: scrollyContainer
  });
  
  // Register linked camera group if specified
  var linkedGroup = overlay.dataset.linkedGroup;
  if (linkedGroup) {
    // Small delay to ensure editor is mounted
    setTimeout(function() {
      Drawable.registerLinkedCamera(id, linkedGroup);
    }, 100);
  }
}

// Auto-wrap figures on page load
document.addEventListener('DOMContentLoaded', function() {
  var figCounter = 0;
  
  // Wrap image-toggle figures (one drawable for the whole stack)
  document.querySelectorAll('.image-toggle').forEach(function(toggle) {
    if (toggle.closest('.drawable-wrapper')) return; // Already wrapped
    figCounter++;
    wrapWithDrawable(toggle, 'drawable-toggle-' + figCounter, true);
  });
  
  // Wrap standalone cell-output-display (but not inside image-toggle)
  document.querySelectorAll('.cell-output-display').forEach(function(cell) {
    if (cell.closest('.image-toggle')) return; // Inside image-toggle, skip
    if (cell.closest('.drawable-wrapper')) return; // Already wrapped
    if (!cell.querySelector('svg, img')) return; // No image, skip
    figCounter++;
    wrapWithDrawable(cell, 'drawable-fig-' + figCounter, true);
  });
});

function wrapWithDrawable(el, id, syncCamera) {
  // Create wrapper structure
  var wrapper = document.createElement('div');
  wrapper.className = 'drawable-wrapper';
  wrapper.style.cssText = 'position: relative; margin: 1em 0; overflow: hidden;';
  
  var content = document.createElement('div');
  content.className = 'drawable-content';
  content.style.cssText = 'overflow: hidden;';
  
  // Insert wrapper before element, then move element inside
  el.parentNode.insertBefore(wrapper, el);
  content.appendChild(el);
  wrapper.appendChild(content);
  
  // Create overlay
  var overlay = document.createElement('div');
  overlay.className = 'drawable-overlay';
  overlay.id = id;
  overlay.dataset.drawable = '';
  overlay.dataset.persist = 'false';
  overlay.dataset.syncCamera = syncCamera ? 'true' : 'false';
  overlay.style.cssText = 'position: absolute; top: 0; left: 0; right: 0; height: 100%; z-index: 100; pointer-events: none;';
  wrapper.appendChild(overlay);
  
  // Create toggle button
  var btn = document.createElement('button');
  btn.className = 'drawable-toggle';
  btn.textContent = '✏️';
  btn.style.cssText = 'position: absolute; top: 8px; right: 8px; z-index: 101; width: 36px; height: 36px; background: rgba(255,255,255,0.9); border: 1px solid #ddd; border-radius: 8px; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; transition: all 0.2s ease; box-shadow: 0 2px 4px rgba(0,0,0,0.1);';
  btn.onclick = function() { toggleDrawable(id); };
  wrapper.appendChild(btn);
}
</script>
]]
end

-- Wrap content with drawable overlay
local function make_drawable(content, id, height, persist, sync_camera)
  local html_before = string.format([[
<div class="drawable-wrapper" style="position: relative; margin: 1em 0; overflow: hidden;">
  <div class="drawable-content" style="overflow: hidden;">
]], id)

  local html_after = string.format([[
  </div>
  <div class="drawable-overlay" id="%s" data-drawable data-persist="%s" data-sync-camera="%s" style="position: absolute; top: 0; left: 0; right: 0; height: %s; z-index: 100; pointer-events: none;"></div>
  <button class="drawable-toggle" onclick="toggleDrawable('%s')" style="position: absolute; top: 8px; right: 8px; z-index: 101; width: 36px; height: 36px; background: rgba(255,255,255,0.9); border: 1px solid #ddd; border-radius: 8px; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; transition: all 0.2s ease; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    ✏️
  </button>
</div>
%s]], id, persist, sync_camera, height, id, get_script())

  return {
    pandoc.RawBlock("html", html_before),
    content,
    pandoc.RawBlock("html", html_after)
  }
end

-- Inject the toggle script at end of document (only for opt-in .drawable elements)
function Pandoc(doc)
  local script = [[
<script>
function toggleDrawable(id) {
  var overlay = document.getElementById(id);
  var btn = overlay.nextElementSibling;
  var resetBtn = overlay.resetBtn;
  
  // Lazy init on first click
  if (!overlay.dataset.drawableInit) {
    initDrawable(id);
  }
  
  var isDrawing = overlay.dataset.drawing === 'true';
  var syncCamera = overlay.dataset.syncCamera === 'true';
  if (!isDrawing) {
    // Enable drawing mode
    overlay.dataset.drawing = 'true';
    overlay.style.pointerEvents = 'auto';
    btn.textContent = '✕';
    if (resetBtn) {
      resetBtn.style.pointerEvents = 'auto';
    }
    // Add drawing-active class after a delay to let TLDraw mount
    setTimeout(function() {
      overlay.classList.add('drawing-active');
    }, 100);
    Drawable.setDrawingMode(id, true);
    if (syncCamera) {
      Drawable.setCameraActive(id, true);
    }
  } else {
    // Disable drawing mode (but keep canvas visible)
    overlay.dataset.drawing = 'false';
    overlay.style.pointerEvents = 'none';
    overlay.classList.remove('drawing-active');
    btn.textContent = '✏️';
    if (resetBtn) {
      resetBtn.style.pointerEvents = 'none';
    }
    Drawable.setDrawingMode(id, false);
    if (syncCamera) {
      Drawable.setCameraActive(id, false);
    }
  }
}

// Initialize drawable lazily when first clicked
function initDrawable(id) {
  var overlay = document.getElementById(id);
  if (!overlay || overlay.dataset.drawableInit) return;
  
  var syncCamera = overlay.dataset.syncCamera === 'true';
  var isScrolly = overlay.dataset.scrolly === 'true';
  overlay.dataset.drawableInit = 'true';
  overlay.dataset.drawing = 'false';
  
  // For scrolly, find the image-toggle container
  var scrollyContainer = null;
  if (isScrolly) {
    var figureCol = overlay.closest('.image-toggle-figure');
    scrollyContainer = figureCol?.querySelector('.image-toggle');
  }
  
  Drawable.mount(overlay, { 
    persist: overlay.dataset.persist === 'true', 
    id: id,
    syncCamera: syncCamera,
    scrolly: isScrolly,
    scrollyContainer: scrollyContainer
  });
  
  // Register linked camera group if specified
  var linkedGroup = overlay.dataset.linkedGroup;
  if (linkedGroup) {
    // Small delay to ensure editor is mounted
    setTimeout(function() {
      Drawable.registerLinkedCamera(id, linkedGroup);
    }, 100);
  }
}

// Inject drawable into image-toggle figures AFTER image-toggle has set up its structure
// Run after a delay to let image-toggle do its work first
setTimeout(function() {
  // Check if image-toggle has run yet
  if (!document.querySelector('.image-toggle-sidebar')) {
    setTimeout(arguments.callee, 500);
    return;
  }
  var figCounter = 0;
  document.querySelectorAll('.image-toggle.drawable').forEach(function(toggle) {
    figCounter++;
    var id = 'drawable-toggle-' + figCounter;
    
    // For sidebar layout, find the figure column; otherwise use the toggle itself
    var sidebar = toggle.closest('.image-toggle-sidebar');
    var figureCol = sidebar?.querySelector('.image-toggle-figure') || toggle;
    
    // Make the target position:relative if not already
    figureCol.style.position = 'relative';
    
    // Create overlay
    var overlay = document.createElement('div');
    overlay.className = 'drawable-overlay';
    overlay.id = id;
    overlay.dataset.drawable = '';
    overlay.dataset.persist = 'false';
    overlay.dataset.syncCamera = 'true';
    overlay.dataset.scrolly = 'true';
    overlay.style.cssText = 'position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 100; pointer-events: none;';
    figureCol.appendChild(overlay);
    
    // Create toggle button
    var btn = document.createElement('button');
    btn.className = 'drawable-toggle';
    btn.textContent = '✏️';
    btn.style.cssText = 'position: absolute; top: 8px; right: 8px; z-index: 101; width: 36px; height: 36px; background: rgba(255,255,255,0.9); border: 1px solid #ddd; border-radius: 8px; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; transition: all 0.2s ease; box-shadow: 0 2px 4px rgba(0,0,0,0.1);';
    btn.onclick = function(e) { 
      e.stopPropagation();
      toggleDrawable(id); 
    };
    figureCol.appendChild(btn);
    
    // Create reset button
    var resetBtn = document.createElement('button');
    resetBtn.className = 'drawable-reset';
    resetBtn.textContent = '⟲';
    resetBtn.title = 'Reset view';
    resetBtn.style.cssText = 'position: absolute; top: 8px; right: 52px; z-index: 101; width: 36px; height: 36px; background: rgba(255,255,255,0.9); border: 1px solid #ddd; border-radius: 8px; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; transition: all 0.2s ease; box-shadow: 0 2px 4px rgba(0,0,0,0.1); pointer-events: none;';
    resetBtn.onclick = function(e) {
      e.stopPropagation();
      Drawable.resetCamera(id);
    };
    figureCol.appendChild(resetBtn);
    
    // Show reset button when drawing is active
    overlay.resetBtn = resetBtn;
  });
  
  // Handle linked-cameras groups
  var linkedGroupCounter = 0;
  document.querySelectorAll('.linked-cameras').forEach(function(group) {
    linkedGroupCounter++;
    var groupName = group.dataset.group || ('linked-group-' + linkedGroupCounter);
    var figCounter = 0;
    
    // Find all figures/plots inside this group
    group.querySelectorAll('.cell-output-display, .quarto-layout-cell').forEach(function(cell) {
      if (cell.closest('.image-toggle')) return; // Skip scrolly images
      if (!cell.querySelector('svg, img')) return; // No image
      
      figCounter++;
      var id = 'linked-' + groupName + '-' + figCounter;
      
      // Make cell position relative
      cell.style.position = 'relative';
      
      // Create overlay
      var overlay = document.createElement('div');
      overlay.className = 'drawable-overlay';
      overlay.id = id;
      overlay.dataset.drawable = '';
      overlay.dataset.persist = 'false';
      overlay.dataset.syncCamera = 'true';
      overlay.dataset.linkedGroup = groupName;
      overlay.style.cssText = 'position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 100; pointer-events: none;';
      cell.appendChild(overlay);
      
      // Create toggle button
      var btn = document.createElement('button');
      btn.className = 'drawable-toggle';
      btn.textContent = '✏️';
      btn.style.cssText = 'position: absolute; top: 8px; right: 8px; z-index: 101; width: 36px; height: 36px; background: rgba(255,255,255,0.9); border: 1px solid #ddd; border-radius: 8px; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; transition: all 0.2s ease; box-shadow: 0 2px 4px rgba(0,0,0,0.1);';
      btn.onclick = function(e) { 
        e.stopPropagation();
        // Init all drawables in this linked group first
        document.querySelectorAll('[data-linked-group="' + groupName + '"]').forEach(function(o) {
          if (!o.dataset.drawableInit) {
            initDrawable(o.id);
          }
        });
        toggleDrawable(id); 
      };
      cell.appendChild(btn);
      
      // Create reset button
      var resetBtn = document.createElement('button');
      resetBtn.className = 'drawable-reset';
      resetBtn.textContent = '⟲';
      resetBtn.title = 'Reset view';
      resetBtn.style.cssText = 'position: absolute; top: 8px; right: 52px; z-index: 101; width: 36px; height: 36px; background: rgba(255,255,255,0.9); border: 1px solid #ddd; border-radius: 8px; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; transition: all 0.2s ease; box-shadow: 0 2px 4px rgba(0,0,0,0.1); pointer-events: none;';
      resetBtn.onclick = function(e) {
        e.stopPropagation();
        // Reset all cameras in the group
        document.querySelectorAll('[data-linked-group="' + groupName + '"]').forEach(function(o) {
          Drawable.resetCamera(o.id);
        });
      };
      cell.appendChild(resetBtn);
      
      overlay.resetBtn = resetBtn;
    });
  });
}, 100);
</script>
]]
  table.insert(doc.blocks, pandoc.RawBlock("html", script))
  return doc
end

-- Process .drawable divs at build time
local drawable_counter = 0

-- Check if a Div is a drawable context
local function is_drawable_context(el)
  return el.classes:includes("drawable") or 
         el.classes:includes("linked-cameras") or
         (el.classes:includes("image-toggle") and el.classes:includes("drawable"))
end

-- Inline SVGs within a drawable context
local function inline_svgs_in_div(el)
  return el:walk({
    Image = function(img)
      if img.src:match('%.svg$') then
        local ok, svg_str = pcall(read_svg, img.src)
        if ok and svg_str then
          return pandoc.RawInline('html', svg_str)
        end
      end
      return img
    end
  })
end

function Div(el)
  -- For drawable contexts, inline SVGs first
  if is_drawable_context(el) then
    el = inline_svgs_in_div(el)
  end
  
  -- For image-toggle with .drawable, leave it alone - JS handles it at runtime
  if el.classes:includes("image-toggle") and el.classes:includes("drawable") then
    return el
  end
  
  -- For linked-cameras, just return (JS handles at runtime)
  if el.classes:includes("linked-cameras") then
    return el
  end
  
  -- For regular .drawable divs, wrap with overlay structure
  if el.classes:includes("drawable") then
    drawable_counter = drawable_counter + 1
    local id = "drawable-" .. drawable_counter
    local persist = el.attributes["persist"] == "true" and "true" or "false"
    local sync_camera = el.attributes["sync-camera"] ~= "false" and "true" or "false"
    
    return make_drawable(el.content, id, "100%", persist, sync_camera)
  end
end
