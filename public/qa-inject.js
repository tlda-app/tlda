(function() {
  var canvas = document.querySelector('.tl-canvas');
  if (!canvas) { window.__qaResult = 'no canvas'; return; }
  var fk = Object.keys(canvas).find(function(k) { return k.startsWith('__reactFiber'); });
  if (!fk) { window.__qaResult = 'no fiber'; return; }
  var fiber = canvas[fk];
  var ed = null;
  var depth = 0;
  while (depth < 80 && fiber && !ed) {
    var st = fiber.memoizedState;
    var stD = 0;
    while (stD < 40 && st && !ed) {
      var v = st.memoizedState;
      if (v && typeof v === 'object' && v.current && typeof v.current.createShape === 'function') {
        ed = v.current;
      }
      st = st.next;
      stD++;
    }
    fiber = fiber.return;
    depth++;
  }
  if (ed) {
    window.__tldrawEditor = ed;
    window.__qaResult = 'editor found';
  } else {
    window.__qaResult = 'editor not found after ' + depth + ' levels';
  }
})();
