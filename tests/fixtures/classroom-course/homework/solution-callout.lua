-- This course's solution filter. Labels every solution div in the solution
-- render, so a rendered artifact says which variant it is.
function Div(el)
  if el.classes:includes('callout-solution') then
    table.insert(el.content, 1, pandoc.Para(pandoc.Strong('Solution')))
  end
  return el
end
