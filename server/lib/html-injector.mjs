/**
 * Injects a bridge script into HTML pages served for html-format tlda projects.
 * The bridge:
 *   - Strips Quarto sidebar/nav for clean embedding
 *   - Reports document height to parent via postMessage
 *   - Observes DOM mutations to re-report height (e.g. webR cell expansion)
 *   - Reads _tldaShape query param to identify itself
 *   - Processes WebR cells: hides echo:false/include:false, strips #| directives
 *   - Dark mode via CSS invert with semantic color preservation
 */


// MathJax v3 configuration — must be injected BEFORE the MathJax <script> tag
// Merges with any existing window.MathJax (e.g. Quarto's physics package loader)
const MATHJAX_CONFIG = `
<script>
(function() {
  var prev = window.MathJax || {};
  var prevTex = prev.tex || {};
  var prevMacros = prevTex.macros || {};
  window.MathJax = Object.assign({}, prev, {
    tex: Object.assign({}, prevTex, {
      macros: Object.assign({}, prevMacros, {
        qqtext: ['\\\\qquad\\\\text{#1}\\\\qquad', 1],
        qty: ['\\\\left(#1\\\\right)', 1],
        qfor: ['\\\\quad\\\\text{for}\\\\quad', 0],
        qand: ['\\\\quad\\\\text{and}\\\\quad', 0],
        qwhere: ['\\\\quad\\\\text{where}\\\\quad', 0],
        E: '\\\\operatorname{E}',
        Var: '\\\\operatorname{V}',
        Cov: '\\\\operatorname{Cov}',
        bias: '\\\\operatorname{bias}',
        RMSE: '\\\\operatorname{RMSE}',
        sd: '\\\\operatorname{sd}',
        hVar: '\\\\widehat{\\\\operatorname{V}}',
        nprior: 'n_0',
        ind: '\\\\perp\\\\!\\\\!\\\\!\\\\perp'
      })
    })
  });
})();
</script>
`

const BRIDGE_SCRIPT = `
<script>
(function() {
  // Read shape ID from query string
  var params = new URLSearchParams(window.location.search);
  var shapeId = params.get('_tldaShape') || '';

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

    // Dark mode: toggle via postMessage from parent, only change backgrounds
    // and default text color — leave semantic colors (plots, colored text) alone
    window.addEventListener('message', function(e) {
      if (e.data?.type === 'tlda-dark-mode') {
        document.documentElement.classList.toggle('tlda-dark', !!e.data.dark);
      }
      if (e.data?.type === 'tlda-figure-transform') {
        var wrapper = document.querySelector('[data-figure-idx="' + e.data.figureIdx + '"]');
        if (!wrapper) return;
        var svg = wrapper.querySelector('svg');
        if (!svg) return;
        svg.style.transformOrigin = '0 0';
        svg.style.transform = 'scale(' + e.data.zoom + ') translate(' + e.data.panX + 'px, ' + e.data.panY + 'px)';
      }
    });
    // Prevent iframe from capturing wheel/touch scroll events (Safari ignores
    // pointer-events:none on iframes for scroll gestures).
    // Forward to parent so TLDraw still scrolls when text-select tool is active.
    document.addEventListener('wheel', function(e) {
      e.preventDefault();
      if (window.parent !== window) {
        window.parent.postMessage({
          type: 'tlda-wheel', shapeId: shapeId,
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
      // Strip query params from targetFile (e.g. "file.html?_tldaShape=..." -> "file.html")
      if (targetFile) targetFile = targetFile.split('?')[0] || null;
      var anchor = parts[1] || null;
      if (window.parent !== window) {
        window.parent.postMessage({
          type: 'tlda-navigate',
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
      '.image-toggle-sidebar div.inlined-svg > svg { max-width: 100%; height: auto; }',
      '.spinner-grow, .spinner-border { opacity: 0.3; }',
      '.exercise-loading-indicator { font-size: 12px; opacity: 0.5; }',
      '.image-toggle .image-toggle-controls { display: none !important; }',
      '.image-toggle-sidebar .image-toggle-steps > * { margin-bottom: 1em; padding: 0.5em 0.75em; border-radius: 6px; border-left: 3px solid rgba(100, 100, 200, 0.12); font-size: 0.95em; line-height: 1.5; cursor: pointer; transition: border-color 0.2s ease, background 0.2s ease; }',
      '.image-toggle-sidebar .image-toggle-steps > *:hover { background: rgba(100, 100, 200, 0.06); }',
      '.image-toggle-sidebar .image-toggle-steps > *.scrolly-active { border-left-color: rgba(80, 100, 200, 0.6); background: rgba(100, 100, 200, 0.06); }',
      // Dark mode: CSS invert on html element, counter-rotate semantic color classes.
      // invert(0.92) lands body text at soft off-white; semantic color counter-filter
      // uses invert(0.92) which isn't a perfect identity but keeps colors recognizable.
      'html.tlda-dark { filter: invert(0.92) hue-rotate(180deg); background: #fff; }',
      // Counter-filter for semantic color classes (text labeled "the red curve" must stay red)
      // Applying the same filter undoes the parent: invert(invert(x)) = x
      'html.tlda-dark .twocolor-red, html.tlda-dark .twocolor-green, html.tlda-dark .groupa, html.tlda-dark .groupb, html.tlda-dark .midnight, html.tlda-dark .polla, html.tlda-dark .pink, html.tlda-dark .pollb, html.tlda-dark .teal, html.tlda-dark .pollc, html.tlda-dark .polld, html.tlda-dark .magenta, html.tlda-dark .counterfactual, html.tlda-dark .green, html.tlda-dark .cyan, html.tlda-dark .population, html.tlda-dark .blue, html.tlda-dark .sample, html.tlda-dark .red, html.tlda-dark .purple, html.tlda-dark .target, html.tlda-dark .shadedred, html.tlda-dark .todofix { filter: invert(0.92) hue-rotate(180deg); }',
      // Counter-filter for semantic colors in inline SVG plots (tagged by inline-svg.lua)
      'html.tlda-dark .darkmode-invariant { filter: invert(0.92) hue-rotate(180deg); }',
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
    // Prefer <main> bottom to avoid hidden Quarto sidebar/nav inflating height
    var main = document.querySelector('main');
    var h;
    if (main) {
      var rect = main.getBoundingClientRect();
      h = Math.ceil(rect.bottom + window.scrollY);
    } else {
      h = Math.max(
        document.body.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.scrollHeight
      );
    }
    if (h > 0 && window.parent !== window) {
      window.parent.postMessage({
        type: 'tlda-resize',
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
        type: 'tlda-headings',
        shapeId: shapeId,
        positions: positions,
      }, '*');
    }
  }

  // Report figure positions and hide originals (replaced by TLDraw shapes on canvas)
  var figuresReported = false;
  function getOffsetY(el) {
    var y = 0;
    while (el) {
      y += el.offsetTop || 0;
      el = el.offsetParent;
    }
    return y;
  }
  function getOffsetX(el) {
    var x = 0;
    while (el) {
      x += el.offsetLeft || 0;
      el = el.offsetParent;
    }
    return x;
  }

  function reportFigures() {
    var result = [];
    var globalIdx = 0;

    // 1. Old-style: <figure> with <img src="...svg">
    var figures = document.querySelectorAll('figure.figure, figure.quarto-float');
    figures.forEach(function(fig) {
      var img = fig.querySelector('img[src$=".svg"]');
      if (!img) return;
      if (fig.closest('.image-toggle')) return;
      var tabPane = fig.closest('.tab-pane');
      if (tabPane && !tabPane.classList.contains('active')) return;
      var rect = fig.getBoundingClientRect();
      if (rect.height < 10) return;
      img.style.visibility = 'hidden';
      var tabset = fig.closest('.panel-tabset');
      result.push({
        svgUrl: img.src,
        offsetY: getOffsetY(fig),
        w: rect.width,
        h: rect.height,
        id: img.id || fig.id || null,
        caption: (fig.querySelector('figcaption') || {}).textContent || null,
        index: globalIdx++,
        group: tabset ? (tabset.id || 'tabset-' + tabset.dataset.group || null) : null,
      });
    });

    // 2. Inline SVGs from the inline-svg Lua filter
    // The overlay is a transparent glass pane — content stays in the iframe for styling.
    // Each wrapper gets a data-figure-idx for targeted transform messages.
    var inlineSvgs = document.querySelectorAll('div.inlined-svg > svg');
    inlineSvgs.forEach(function(svg) {
      var wrapper = svg.parentElement;
      if (wrapper.closest('.image-toggle')) return;
      var tabPane = wrapper.closest('.tab-pane');
      if (tabPane && !tabPane.classList.contains('active')) return;
      // Fix case-sensitive viewBox attribute (svglite outputs lowercase "viewbox")
      // and make SVG scale responsively within its container
      if (!svg.getAttribute('viewBox') && svg.getAttribute('viewbox')) {
        svg.setAttribute('viewBox', svg.getAttribute('viewbox'));
      }
      if (!svg.getAttribute('viewBox')) {
        var w = svg.getAttribute('width'), h = svg.getAttribute('height');
        if (w && h) svg.setAttribute('viewBox', '0 0 ' + parseFloat(w) + ' ' + parseFloat(h));
      }
      svg.style.width = '100%';
      svg.style.height = 'auto';
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      var wrapperRect = wrapper.getBoundingClientRect();
      if (wrapperRect.height < 10) return;
      // Tag wrapper for transform messages and set up clipping
      wrapper.dataset.figureIdx = String(globalIdx);
      wrapper.style.overflow = 'hidden';
      var tabset = wrapper.closest('.panel-tabset');
      var figEl = wrapper.closest('figure');
      result.push({
        svgUrl: '',
        inline: true,
        offsetX: getOffsetX(wrapper),
        offsetY: getOffsetY(wrapper),
        w: wrapperRect.width,
        h: wrapperRect.height,
        id: (figEl && figEl.id) || wrapper.id || null,
        caption: figEl ? (figEl.querySelector('figcaption') || {}).textContent || null : null,
        index: globalIdx++,
        group: tabset ? (tabset.id || 'tabset-' + (tabset.dataset.group || globalIdx)) : null,
      });
    });

    if (result.length > 0 && window.parent !== window) {
      window.parent.postMessage({ type: 'tlda-figures', shapeId: shapeId, figures: result }, '*');
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
      // With inline SVGs (from the Lua filter), there are no <img> tags — serialize SVGs to blob URLs.
      var cells = container.querySelectorAll('.image-toggle-cell');
      var imgUrls = Array.from(cells).map(function(cell) {
        var img = cell.querySelector('img');
        if (img) return img.src;
        var inlineSvg = cell.querySelector('div.inlined-svg > svg');
        if (inlineSvg) {
          var serialized = new XMLSerializer().serializeToString(inlineSvg);
          return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(serialized)));
        }
        return '';
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
        type: 'tlda-scrolly-regions',
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
      setTimeout(reportFigures, 500);
      setTimeout(reportFigures, 2000);
      setTimeout(reportFigures, 5000);
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
    setTimeout(reportFigures, 500);
    setTimeout(reportFigures, 2000);
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
        if (!figuresReported) reportFigures();
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

// Bridge script for reveal.js slides format.
// Navigates to the target slide, disables reveal's own navigation,
// and handles fragment stepping via postMessage from parent.
const SLIDES_BRIDGE_SCRIPT = `
<script>
(function() {
  var params = new URLSearchParams(window.location.search);
  var shapeId = params.get('_tldaShape') || '';
  var indexh = parseInt(params.get('_tldaH') || '0', 10);
  var indexv = parseInt(params.get('_tldaV') || '0', 10);

  function init() {
    if (typeof Reveal === 'undefined' || !Reveal.isReady || !Reveal.isReady()) {
      setTimeout(init, 100);
      return;
    }

    // Navigate to the target slide using (indexh, indexv) coordinates
    Reveal.slide(indexh, indexv, 0);

    // Signal parent that this slide is ready to show (triggers fade-in)
    setTimeout(function() {
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'tlda-slide-ready', shapeId: shapeId }, '*');
      }
    }, 150);

    // Disable reveal's own navigation UI and wheel handling
    Reveal.configure({
      keyboard: false,
      controls: false,
      touch: false,
      mouseWheel: false,
      embedded: true,
      progress: false,
      slideNumber: false,
      hash: false,
      history: false,
      overview: false,
    });

    // Prevent reveal from changing slides (lock to this slide)
    Reveal.on('slidechanged', function(ev) {
      if (ev.indexh !== indexh || ev.indexv !== indexv) {
        Reveal.slide(indexh, indexv, 0);
      }
    });

    // Hide non-essential UI elements
    var style = document.createElement('style');
    style.textContent = [
      '.reveal .controls { display: none !important; }',
      '.reveal .progress { display: none !important; }',
      '.reveal .slide-number { display: none !important; }',
      '.reveal .slide-menu-button { display: none !important; }',
      '.reveal .slide-chalkboard-buttons { display: none !important; }',
      '.reveal .footer { display: none !important; }',
      '.reveal .slide-logo { display: none !important; }',
      'body { overflow: hidden !important; margin: 0; }',
      // Dark mode
      'html.tlda-dark .reveal { filter: invert(0.92) hue-rotate(180deg); }',
      'html.tlda-dark .reveal img, html.tlda-dark .reveal svg, html.tlda-dark .reveal video { filter: invert(0.92) hue-rotate(180deg); }',
    ].join('\\n');
    document.head.appendChild(style);

    // Listen for messages from parent (edge tap zones, dark mode)
    window.addEventListener('message', function(e) {
      if (!e.data || !e.data.type) return;
      if (e.data.type === 'tlda-fragment-next') {
        var avail = Reveal.availableFragments();
        if (avail && avail.next) {
          Reveal.next();
        }
        // If no more fragments, do nothing — the tap zone in the parent
        // can handle "advance past last fragment" if needed later
      }
      if (e.data.type === 'tlda-fragment-prev') {
        var avail = Reveal.availableFragments();
        if (avail && avail.prev) {
          Reveal.prev();
        }
      }
      if (e.data.type === 'tlda-dark-mode') {
        document.documentElement.classList.toggle('tlda-dark', !!e.data.dark);
      }
    });

    // Forward wheel events to parent (TLDraw handles scrolling)
    document.addEventListener('wheel', function(e) {
      e.preventDefault();
      if (window.parent !== window) {
        window.parent.postMessage({
          type: 'tlda-wheel', shapeId: shapeId,
          deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
          ctrlKey: e.ctrlKey, metaKey: e.metaKey,
        }, '*');
      }
    }, { passive: false });
    document.addEventListener('touchmove', function(e) { e.preventDefault(); }, { passive: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 50); });
  } else {
    setTimeout(init, 50);
  }
})();
</script>
`

// Injected into <head> before reveal.js loads — clears any stored slide position
// so each iframe starts fresh and navigates to its own _tldaSlide index.
const SLIDES_HEAD_SCRIPT = `
<script>
(function() {
  try {
    Object.keys(sessionStorage).forEach(function(k) {
      if (k.indexOf('reveal') !== -1 || k.indexOf('Reveal') !== -1) {
        sessionStorage.removeItem(k);
      }
    });
  } catch(e) {}
})();
</script>
`

/**
 * Inject slides bridge into reveal.js HTML.
 * Also injects a head script to clear stored reveal state before initialization.
 */
export function injectSlidesBridge(html) {
  // Escape </body> and </html> that appear inside inline scripts to prevent Safari's strict
  // HTML parser from terminating the document early when these sequences appear in JS strings.
  // Keep the last occurrence of each (the real structural tag); escape all earlier ones.
  html = html
    .replace(/<\/body>/gi, (match, offset, str) =>
      str.lastIndexOf('</body>') === offset ? match : '<\\/body>')
    .replace(/<\/html>/gi, (match, offset, str) =>
      str.lastIndexOf('</html>') === offset ? match : '<\\/html>')

  // Inject head script before the structural </head> tag.
  // Quarto reveal.js files have multiple </head> occurrences inside JS template literals
  // (e.g. the speaker notes plugin embeds a popup HTML template). The real structural </head>
  // is distinguished by being followed by <body class=... (with a class attribute), while
  // the embedded template </head> tags are followed by plain <body> with no class.
  let patched = html
  const headCloseMatch = /(<\/head>)(\s*<body\s)/i.exec(patched)
  if (headCloseMatch) {
    const headCloseIdx = headCloseMatch.index
    patched = patched.slice(0, headCloseIdx) + SLIDES_HEAD_SCRIPT + patched.slice(headCloseIdx)
  }
  const bodyCloseIdx = patched.lastIndexOf('</body>')
  if (bodyCloseIdx !== -1) {
    return patched.slice(0, bodyCloseIdx) + SLIDES_BRIDGE_SCRIPT + patched.slice(bodyCloseIdx)
  }
  return patched + SLIDES_BRIDGE_SCRIPT
}

/**
 * Inject bridge script into HTML content.
 * Inserts just before </body> or appends to end.
 */
/**
 * Inject only a chapter title card into already-bridged HTML.
 * Use this for markdown-format docs where the bridge is already injected at build time.
 */
// prev/next: { name, title } or null
export function injectChapterTitle(html, chapterTitle, prev = null, next = null) {
  if (!chapterTitle) return html
  const escaped = chapterTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const titleCard = `
<div class="tlda-chapter-title">
  <div class="tlda-chapter-title-text">${escaped}</div>
</div>
<style>
.tlda-chapter-title {
  padding: 40px 0 32px;
  text-align: center;
  border-bottom: 1px solid #ccc;
  margin-bottom: 32px;
}
.tlda-chapter-title-text {
  font-family: -apple-system, 'Helvetica Neue', sans-serif;
  font-size: 28px;
  font-weight: 300;
  letter-spacing: 0.02em;
  color: #222;
}
.tlda-chapter-nav {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-top: 48px;
  padding-top: 24px;
  border-top: 1px solid #e0e0e0;
  font-family: -apple-system, 'Helvetica Neue', sans-serif;
  font-size: 0.82rem;
  gap: 16px;
}
.tlda-chapter-nav a {
  color: #2563eb;
  text-decoration: none;
  max-width: 45%;
  line-height: 1.4;
}
.tlda-chapter-nav a:hover { text-decoration: underline; }
.tlda-chapter-nav .nav-label { color: #999; display: block; font-size: 0.75rem; margin-bottom: 2px; }
.tlda-chapter-nav .nav-spacer { flex: 1; }
</style>`

  let footer = ''
  if (prev || next) {
    const prevHtml = prev
      ? `<a href="#" onclick="event.preventDefault();window.parent.postMessage({type:'tlda-navigate',targetFile:${JSON.stringify(prev.name)}},'*')">
           <span class="nav-label">← Previous</span>${prev.title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}
         </a>`
      : '<span class="nav-spacer"></span>'
    const nextHtml = next
      ? `<a href="#" style="text-align:right" onclick="event.preventDefault();window.parent.postMessage({type:'tlda-navigate',targetFile:${JSON.stringify(next.name)}},'*')">
           <span class="nav-label">Next →</span>${next.title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}
         </a>`
      : '<span class="nav-spacer"></span>'
    footer = `<div class="tlda-chapter-nav">${prevHtml}${nextHtml}</div>`
  }

  const bodyOpenIdx = html.indexOf('<body')
  if (bodyOpenIdx === -1) return html
  const bodyCloseAngle = html.indexOf('>', bodyOpenIdx)
  if (bodyCloseAngle === -1) return html
  const bodyCloseIdx = html.lastIndexOf('</body>')
  if (bodyCloseIdx === -1) return html

  return html.slice(0, bodyCloseAngle + 1) + titleCard + html.slice(bodyCloseAngle + 1, bodyCloseIdx) + footer + html.slice(bodyCloseIdx)
}

export function injectBridge(html, basePath = '', chapterTitle = '', isFirstPage = false, nav = {}) {
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
<div class="tlda-chapter-title">
  <div class="tlda-chapter-title-text">${escaped}</div>
</div>
<style>
.tlda-chapter-title {
  padding: 40px 0 32px;
  text-align: center;
  border-bottom: 1px solid #ccc;
  margin-bottom: 32px;
}
.tlda-chapter-title-text {
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

  // Inject chapter navigation footer before </body>
  if (nav.prev || nav.next) {
    const escPrev = nav.prev ? nav.prev.replace(/&/g, '&amp;').replace(/</g, '&lt;') : ''
    const escNext = nav.next ? nav.next.replace(/&/g, '&amp;').replace(/</g, '&lt;') : ''
    const navFooter = `
<div class="tlda-chapter-nav">
  ${nav.prev ? `<div class="tlda-nav-prev" onclick="window.parent.postMessage({type:'tlda-navigate-rel',direction:'prev'},'*')"><span class="tlda-nav-arrow">\u2190</span> ${escPrev}</div>` : '<div></div>'}
  ${nav.next ? `<div class="tlda-nav-next" onclick="window.parent.postMessage({type:'tlda-navigate-rel',direction:'next'},'*')"><span class="tlda-nav-arrow">\u2192</span> ${escNext}</div>` : '<div></div>'}
</div>
<style>
.tlda-chapter-nav {
  display: flex;
  justify-content: space-between;
  padding: 40px 20px 60px;
  margin-top: 60px;
  border-top: 1px solid #ccc;
  max-width: 800px;
  margin-left: auto;
  margin-right: auto;
}
.tlda-nav-prev, .tlda-nav-next {
  font-family: -apple-system, 'Helvetica Neue', sans-serif;
  font-size: 14px;
  color: #888;
  cursor: pointer;
  transition: color 0.15s ease;
  max-width: 45%;
}
.tlda-nav-prev:hover, .tlda-nav-next:hover { color: #444; }
.tlda-nav-next { text-align: right; }
.tlda-nav-arrow { font-size: 16px; }
</style>`
    patched = patched.replace('</main>', navFooter + '</main>')
  }

  const bodyCloseIdx = patched.lastIndexOf('</body>')
  if (bodyCloseIdx !== -1) {
    return patched.slice(0, bodyCloseIdx) + BRIDGE_SCRIPT + patched.slice(bodyCloseIdx)
  }
  // No </body> tag — just append
  return patched + BRIDGE_SCRIPT
}
