-- inline-svg.lua
-- Inlines all SVG images at build time.
-- Enables per-element CSS targeting (dark mode, semantic color preservation).

local svg_counter = 0

-- Semantic colors that must survive dark mode inversion (lowercase hex)
-- These match the definitions in class.scss and shared-code.qmd
local SEMANTIC_COLORS = {
  ["#f8766d"] = true, ["#00bfc4"] = true,  -- groupa/groupb
  ["#073b4c"] = true,                       -- midnight/polla
  ["#ef476f"] = true,                       -- pink/pollb
  ["#118ab2"] = true,                       -- teal/pollc
  ["#06d6a0"] = true,                       -- green/polld
  ["#ffd166"] = true,                       -- mustard/polle
  ["#ff00ff"] = true,                       -- magenta/counterfactual
  ["#00ff00"] = true, ["#00ffff"] = true,   -- green, cyan/population
  ["#0000ff"] = true, ["#ff0000"] = true,   -- blue/sample, red
  ["#a020f0"] = true,                       -- purple
}

local function read_file(path)
  local fh = assert(io.open(path, "rb"))
  local contents = assert(fh:read(_VERSION <= "Lua 5.2" and "*a" or "a"))
  fh:close()
  return contents
end

local function read_svg(path)
  local svg_content = read_file(path)
  -- Remove XML declaration
  svg_content = svg_content:gsub('^<%?xml[^?]*%?>%s*', '')
  -- Remove 'pt' units from width/height so browser treats them as px
  svg_content = svg_content:gsub('(%d+[.]?%d*)pt', '%1')
  -- Namespace IDs to avoid clipPath collisions between inlined SVGs
  svg_counter = svg_counter + 1
  local prefix = "svg" .. svg_counter .. "-"
  -- Collect all id values
  local ids = {}
  for id in svg_content:gmatch('id=["\']([^"\']+)["\']') do
    ids[id] = true
  end
  -- Replace each ID and its references (url(#id), href="#id", etc.)
  for id, _ in pairs(ids) do
    local escaped = id:gsub('([%(%)%.%%%+%-%*%?%[%]%^%$])', '%%%1')
    svg_content = svg_content:gsub(escaped, prefix .. id)
  end
  -- Tag elements with semantic fill/stroke colors for dark mode counter-filter
  -- Match any SVG element tag that contains a style attribute with a semantic color
  svg_content = svg_content:gsub('<([a-z]+)(%s[^>]-)(/?)>', function(tagname, attrs, slash)
    local style_lower = attrs:lower()
    local fill = style_lower:match('fill:%s*(#[0-9a-f]+)')
    local stroke = style_lower:match('stroke:%s*(#[0-9a-f]+)')
    if (fill and SEMANTIC_COLORS[fill]) or (stroke and SEMANTIC_COLORS[stroke]) then
      return '<' .. tagname .. ' class="ctd-semantic"' .. attrs .. slash .. '>'
    end
    return '<' .. tagname .. attrs .. slash .. '>'
  end)
  return svg_content
end

function Image(img)
  if img.src:match('%.svg$') then
    local ok, svg_str = pcall(read_svg, img.src)
    if ok and svg_str then
      -- Wrap in a div preserving the figure's width
      local width = img.attributes and img.attributes.width
      local style = 'max-width:100%;height:auto'
      if width then
        style = 'width:' .. width .. ';max-width:100%;height:auto'
      end
      local html = '<div class="ctd-inline-svg" style="' .. style .. '">' .. svg_str .. '</div>'
      return pandoc.RawInline('html', html)
    end
  end
  return img
end
