/**
 * Injects a bridge script into HTML pages served for html-format ctd projects.
 * The bridge:
 *   - Strips Quarto sidebar/nav for clean embedding
 *   - Reports document height to parent via postMessage
 *   - Observes DOM mutations to re-report height (e.g. webR cell expansion)
 *   - Reads _ctdShape query param to identify itself
 *   - Processes WebR cells: hides echo:false/include:false, strips #| directives
 */

// MathJax v3 configuration — must be injected BEFORE the MathJax <script> tag
const MATHJAX_CONFIG = `
<script>
window.MathJax = {
  tex: {
    macros: {
      qqtext: ['\\\\qquad\\\\text{#1}\\\\qquad', 1],
      qty: ['\\\\left(#1\\\\right)', 1],
      qfor: ['\\\\quad\\\\text{for}\\\\quad', 0],
      qand: ['\\\\quad\\\\text{and}\\\\quad', 0],
      qwhere: ['\\\\quad\\\\text{where}\\\\quad', 0]
    }
  }
};
</script>
`

const BRIDGE_SCRIPT = `
<script>
(function() {
  // Read shape ID from query string
  var params = new URLSearchParams(window.location.search);
  var shapeId = params.get('_ctdShape') || '';

  // Strip Quarto navigation elements for clean embedding
  function stripNav() {
    var selectors = [
      '#quarto-sidebar',
      '#quarto-margin-sidebar',
      '.navbar',
      '#quarto-header',
      '#quarto-back-to-top',
      '.nav-footer',
      '#quarto-overlay',
      '#quarto-search',
      '.page-navigation',
      '.quarto-title-breadcrumbs',
    ];
    selectors.forEach(function(sel) {
      var el = document.querySelector(sel);
      if (el) el.remove();
    });
    // Hide the first h1 — redundant with the injected title card
    var firstH1 = document.querySelector('h1');
    if (firstH1) firstH1.style.display = 'none';
    // Make content full-width (remove sidebar offset)
    var main = document.querySelector('#quarto-content');
    if (main) {
      main.style.marginLeft = '0';
      main.style.paddingLeft = '0';
    }
    var content = document.querySelector('.page-columns');
    if (content) {
      content.style.display = 'block';
    }
    // Add padding to approximate default article margins (1in each side at 800/612 scale)
    document.body.style.margin = '0';
    document.body.style.padding = '0 90px';
    document.body.style.overflow = 'hidden';
    document.body.style.background = 'transparent';
    document.documentElement.style.background = 'transparent';
    // Prevent iframe from capturing wheel/touch scroll events (Safari ignores
    // pointer-events:none on iframes for scroll gestures).
    // Forward to parent so TLDraw still scrolls when text-select tool is active.
    document.addEventListener('wheel', function(e) {
      e.preventDefault();
      if (window.parent !== window) {
        window.parent.postMessage({
          type: 'ctd-wheel', shapeId: shapeId,
          deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
          ctrlKey: e.ctrlKey, metaKey: e.metaKey,
        }, '*');
      }
    }, { passive: false });
    document.addEventListener('touchmove', function(e) { e.preventDefault(); }, { passive: false });
    // Intercept link clicks — route navigation through parent canvas
    document.addEventListener('click', function(e) {
      var a = e.target.closest('a[href]');
      if (!a) return;
      var href = a.getAttribute('href');
      if (!href || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
      // External links: open in new tab
      if (/^https?:\\/\\//.test(href) && !href.includes(window.location.host)) {
        e.preventDefault();
        window.open(href, '_blank');
        return;
      }
      e.preventDefault();
      // Parse href: same-host full URLs, relative paths, or bare anchors
      // Same-host full URLs (Quarto cross-refs like "http://host/docs/name/...#fig-id")
      // → treat as in-page anchor if they point to this same iframe URL
      var parsed = href;
      if (/^https?:\\/\\//.test(href) && href.includes(window.location.host)) {
        // Extract just the hash portion — these are same-document cross-refs
        var hashIdx = href.indexOf('#');
        parsed = hashIdx >= 0 ? href.slice(hashIdx) : '';
      }
      var parts = parsed.split('#');
      var targetFile = (parts[0] || '').replace(/^\\.\\//,'').replace(/^.*\\//,'') || null;
      // Strip query params from targetFile (e.g. "file.html?_ctdShape=..." -> "file.html")
      if (targetFile) targetFile = targetFile.split('?')[0] || null;
      var anchor = parts[1] || null;
      if (window.parent !== window) {
        window.parent.postMessage({
          type: 'ctd-navigate',
          shapeId: shapeId,
          targetFile: targetFile,
          anchor: anchor,
        }, '*');
      }
    }, true);
    // Hide WebR loading spinners (bracket chars) but keep the container visible
    // so code editors and outputs remain accessible
    var style = document.createElement('style');
    style.textContent = [
      '.ojs-in-a-box-waiting-for-module-import::before, .ojs-in-a-box-waiting-for-module-import::after { display: none !important; }',
      '.ojs-in-a-box-waiting-for-module-import > .ojs-in-a-box-turn-off-waiter { display: none !important; }',
      '.panel-tabset > .nav-tabs { background: #fff; position: relative; z-index: 2; }',
      '.cm-editor { max-width: 100% !important; overflow-x: auto !important; }',
      '.cm-line { overflow-wrap: anywhere; }',
      '.cell-output img, .cell-output svg { max-width: 100%; height: auto; }',
      '.image-toggle .image-toggle-controls { display: none !important; }',
      '.image-toggle-sidebar .image-toggle-steps > * { margin-bottom: 1em; padding: 0.5em 0.75em; border-radius: 6px; border-left: 3px solid rgba(100, 100, 200, 0.12); font-size: 0.95em; line-height: 1.5; cursor: pointer; transition: border-color 0.2s ease, background 0.2s ease; }',
      '.image-toggle-sidebar .image-toggle-steps > *:hover { background: rgba(100, 100, 200, 0.06); }',
      '.image-toggle-sidebar .image-toggle-steps > *.scrolly-active { border-left-color: rgba(80, 100, 200, 0.6); background: rgba(100, 100, 200, 0.06); }',
    ].join('\\n');
    document.head.appendChild(style);
  }

  // Hide WebR cells when WebR runtime is not available.
  // With live-html format, WebR is embedded — don't call this.
  function processWebRCells() {
    var pres = document.querySelectorAll('pre[class="{webr}"]');
    pres.forEach(function(pre) {
      var cell = pre.closest('.cell');
      if (cell) cell.style.display = 'none';
      else pre.style.display = 'none';
    });
  }

  // Report height to parent
  function reportHeight() {
    var h = Math.max(
      document.body.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.scrollHeight
    );
    if (h > 0 && window.parent !== window) {
      window.parent.postMessage({
        type: 'ctd-resize',
        shapeId: shapeId,
        height: h,
      }, '*');
    }
  }

  // Report anchor Y positions for navigation (headings, figures, tables, sections)
  function reportHeadings() {
    var elements = document.querySelectorAll('[id]');
    var positions = {};
    elements.forEach(function(el) {
      var id = el.id;
      if (!id) return;
      var y = 0;
      var node = el;
      while (node) {
        y += node.offsetTop || 0;
        node = node.offsetParent;
      }
      positions[id] = y;
    });
    if (Object.keys(positions).length > 0 && window.parent !== window) {
      window.parent.postMessage({
        type: 'ctd-headings',
        shapeId: shapeId,
        positions: positions,
      }, '*');
    }
  }

  // Report figure positions and hide originals (replaced by TLDraw shapes on canvas)
  var figuresReported = false;
  function reportFigures() {
    var figures = document.querySelectorAll('figure.figure, figure.quarto-float');
    var result = [];
    figures.forEach(function(fig, idx) {
      var img = fig.querySelector('img[src$=".svg"]');
      if (!img) return;
      // Skip figures inside image-toggle containers (interactive scrollytelling)
      if (fig.closest('.image-toggle')) return;
      // Skip figures inside inactive tab panes
      var tabPane = fig.closest('.tab-pane');
      if (tabPane && !tabPane.classList.contains('active')) return;
      var rect = fig.getBoundingClientRect();
      if (rect.height < 10) return;
      // Hide the original image and insert placeholder to preserve layout
      img.style.visibility = 'hidden';
      var placeholder = fig.querySelector('.ctd-figure-placeholder');
      if (!placeholder) {
        placeholder = document.createElement('div');
        placeholder.className = 'ctd-figure-placeholder';
        placeholder.style.width = rect.width + 'px';
        placeholder.style.height = rect.height + 'px';
      } else {
        placeholder.style.width = rect.width + 'px';
        placeholder.style.height = rect.height + 'px';
      }
      // Get absolute Y position in the document
      var y = 0;
      var el = fig;
      while (el) {
        y += el.offsetTop || 0;
        el = el.offsetParent;
      }
      result.push({
        svgUrl: img.src,
        offsetY: y,
        w: rect.width,
        h: rect.height,
        id: img.id || fig.id || null,
        caption: (fig.querySelector('figcaption') || {}).textContent || null,
        index: idx,
      });
    });
    if (result.length > 0 && window.parent !== window) {
      window.parent.postMessage({ type: 'ctd-figures', shapeId: shapeId, figures: result }, '*');
      figuresReported = true;
    }
  }

  // Report scrollytelling region metadata to parent for overlay rendering.
  // The overlay shows the figure in a floating panel; step text stays inline.
  // Note: image-toggle.js (Quarto extension) restructures the DOM before this
  // runs — sidebar toggles get wrapped in .image-toggle-sidebar with step text
  // moved into .image-toggle-steps. Cells get .image-toggle-cell class.
  function reportScrollyRegions() {
    var containers = document.querySelectorAll('.image-toggle');
    if (containers.length === 0) return;

    function getOffsetY(el) {
      var y = 0;
      while (el) { y += el.offsetTop || 0; el = el.offsetParent; }
      return y;
    }

    var regions = [];
    containers.forEach(function(container, idx) {
      var containerY = getOffsetY(container);
      var labels = (container.getAttribute('data-labels') || '').split(',').map(function(s) { return s.trim(); });
      var stepSel = container.getAttribute('data-steps');

      // Find images: image-toggle.js wraps cells in .image-toggle-stack > .image-toggle-cell
      var cells = container.querySelectorAll('.image-toggle-cell');
      var imgUrls = Array.from(cells).map(function(cell) {
        var img = cell.querySelector('img');
        return img ? img.src : '';
      });

      // Find step text elements — location depends on layout:
      // Sidebar: moved into .image-toggle-sidebar > .image-toggle-steps
      // Non-sidebar: still siblings of the container
      var stepTextEls = [];
      var sidebar = container.closest('.image-toggle-sidebar');
      if (sidebar) {
        var stepsCol = sidebar.querySelector('.image-toggle-steps');
        if (stepsCol && stepSel) {
          stepTextEls = Array.from(stepsCol.querySelectorAll(stepSel));
        }
      } else if (stepSel) {
        var sibling = container.nextElementSibling;
        while (sibling) {
          if (sibling.matches && sibling.matches(stepSel)) {
            stepTextEls.push(sibling);
          } else if (stepTextEls.length > 0) {
            break;
          }
          sibling = sibling.nextElementSibling;
        }
      }

      // Build steps array
      var numSteps = Math.max(imgUrls.length, stepTextEls.length, labels.length);
      if (numSteps === 0) return;

      var steps = [];
      for (var s = 0; s < numSteps; s++) {
        var stepEl = stepTextEls[s];
        var stepY = stepEl ? getOffsetY(stepEl) : containerY;
        // Extract bold lead-in as label, remainder as text
        var stepLabel = labels[s] || ('Step ' + (s + 1));
        var stepText = '';
        if (stepEl) {
          var strong = stepEl.querySelector('strong, b');
          if (strong) {
            stepLabel = strong.textContent.replace(/[.\s]+$/, '');
            // Get text after the bold element
            var clone = stepEl.cloneNode(true);
            var boldClone = clone.querySelector('strong, b');
            if (boldClone) boldClone.remove();
            stepText = clone.textContent.trim();
          } else {
            stepText = stepEl.textContent.trim();
          }
        }
        steps.push({
          y: stepY,
          label: stepLabel,
          imageUrl: imgUrls[s] || imgUrls[0] || '',
          text: stepText,
        });
      }

      // Click step text → switch figure + highlight active step
      var cellArr = Array.from(cells);
      var stepArr = Array.from(stepTextEls);
      // Mark first step as active initially
      if (stepArr.length > 0) {
        var activeIdx = cellArr.findIndex(function(c) { return c.classList.contains('active'); });
        if (activeIdx >= 0 && activeIdx < stepArr.length) {
          stepArr[activeIdx].classList.add('scrolly-active');
        }
      }
      for (var s2 = 0; s2 < stepArr.length; s2++) {
        (function(stepIdx) {
          stepArr[stepIdx].addEventListener('click', function() {
            for (var c = 0; c < cellArr.length; c++) {
              cellArr[c].classList.toggle('active', c === stepIdx);
            }
            for (var t = 0; t < stepArr.length; t++) {
              stepArr[t].classList.toggle('scrolly-active', t === stepIdx);
            }
          });
        })(s2);
      }

      // Region bounds: top of container to bottom of last step element
      var startY = containerY;
      var endY = containerY + (container.offsetHeight || 200);
      // For sidebar, use the sidebar wrapper bounds
      if (sidebar) {
        startY = getOffsetY(sidebar);
        endY = startY + sidebar.offsetHeight;
      }
      if (stepTextEls.length > 0) {
        var lastEl = stepTextEls[stepTextEls.length - 1];
        var lastY = getOffsetY(lastEl) + lastEl.offsetHeight;
        if (lastY > endY) endY = lastY;
      }

      regions.push({
        id: container.id || ('scrolly-' + idx),
        startY: startY,
        endY: endY,
        steps: steps,
      });
    });

    if (regions.length > 0 && window.parent !== window) {
      window.parent.postMessage({
        type: 'ctd-scrolly-regions',
        shapeId: shapeId,
        regions: regions,
      }, '*');
    }
  }

  // Strip nav on DOMContentLoaded, then measure
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      stripNav();
      // processWebRCells(); // Disabled — live-html includes WebR runtime
      // Early reports for fast anchor resolution, later reports for MathJax accuracy
      setTimeout(reportHeight, 200);
      setTimeout(reportHeight, 500);
      setTimeout(reportHeight, 2000);
      setTimeout(reportHeight, 5000);
      setTimeout(reportHeadings, 200);
      setTimeout(reportHeadings, 1000);
      setTimeout(reportHeadings, 3000);
      setTimeout(reportHeadings, 6000);
      setTimeout(reportScrollyRegions, 200);
      setTimeout(reportScrollyRegions, 1000);
      setTimeout(reportScrollyRegions, 3000);
    });
  } else {
    stripNav();
    processWebRCells();
    setTimeout(reportHeight, 100);
    setTimeout(reportHeight, 2000);
    setTimeout(reportHeadings, 500);
    setTimeout(reportHeadings, 2500);
    setTimeout(reportScrollyRegions, 500);
    setTimeout(reportScrollyRegions, 2500);
  }

  // Observe DOM mutations (webR output, MathJax rendering, etc.)
  var lastHeight = 0;
  var debounceTimer = null;
  var observer = new MutationObserver(function() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function() {
      var h = document.body.scrollHeight;
      if (Math.abs(h - lastHeight) > 10) {
        lastHeight = h;
        reportHeight();
        reportHeadings();
        reportScrollyRegions();
      }
    }, 300);
  });

  // Start observing once DOM is ready
  function startObserver() {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: false,
    });
  }

  if (document.body) {
    startObserver();
  } else {
    document.addEventListener('DOMContentLoaded', startObserver);
  }
})();
</script>
`

/**
 * Inject bridge script into HTML content.
 * Inserts just before </body> or appends to end.
 */
export function injectBridge(html, basePath = '', chapterTitle = '', isFirstPage = false) {
  // Fix relative paths — Quarto chapters in subdirs reference ../site_libs/
  // Rewrite to absolute doc path so assets resolve correctly from iframe
  let patched = basePath
    ? html.replace(/(?:\.\.\/)+site_libs\//g, basePath + 'site_libs/')
      .replace(/(?:\.\.\/)+figs\//g, basePath + 'figs/')
    : html.replace(/(?:\.\.\/)+site_libs\//g, 'site_libs/')

  // Inject MathJax config before MathJax loads (must precede the <script src="...mathjax...">)
  const mathjaxScriptIdx = patched.indexOf('mathjax@3')
  if (mathjaxScriptIdx !== -1) {
    // Find the opening <script of the MathJax tag
    const scriptStart = patched.lastIndexOf('<script', mathjaxScriptIdx)
    if (scriptStart !== -1) {
      patched = patched.slice(0, scriptStart) + MATHJAX_CONFIG + patched.slice(scriptStart)
    }
  }

  // Inject chapter title card after <body>
  if (chapterTitle) {
    const escaped = chapterTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const titleCard = `
<div class="ctd-chapter-title">
  <div class="ctd-chapter-title-text">${escaped}</div>
</div>
<style>
.ctd-chapter-title {
  padding: 80px 0 60px;
  text-align: center;
  border-bottom: 1px solid #ccc;
  margin-bottom: 40px;
}
.ctd-chapter-title-text {
  font-family: -apple-system, 'Helvetica Neue', sans-serif;
  font-size: 28px;
  font-weight: 300;
  letter-spacing: 0.02em;
  color: #222;
}
</style>`
    const bodyOpenIdx = patched.indexOf('<body')
    if (bodyOpenIdx !== -1) {
      const bodyCloseAngle = patched.indexOf('>', bodyOpenIdx)
      if (bodyCloseAngle !== -1) {
        patched = patched.slice(0, bodyCloseAngle + 1) + titleCard + patched.slice(bodyCloseAngle + 1)
      }
    }
  }

  const bodyCloseIdx = patched.lastIndexOf('</body>')
  if (bodyCloseIdx !== -1) {
    return patched.slice(0, bodyCloseIdx) + BRIDGE_SCRIPT + patched.slice(bodyCloseIdx)
  }
  // No </body> tag — just append
  return patched + BRIDGE_SCRIPT
}
