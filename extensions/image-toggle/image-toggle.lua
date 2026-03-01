-- image-toggle.lua
-- Injects JS/CSS for .image-toggle divs
-- All the work is done client-side by the JS

-- Always inject the dependency for HTML output
-- The JS will only activate if it finds .image-toggle divs
if quarto and quarto.doc then
  local script_path = quarto.utils.resolve_path("image-toggle.js")
  local css_path = quarto.utils.resolve_path("image-toggle.css")
  
  quarto.doc.add_html_dependency({
    name = "image-toggle",
    version = "1.0.0",
    scripts = {script_path},
    stylesheets = {css_path}
  })
end

return {}
