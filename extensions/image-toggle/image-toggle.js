// image-toggle.js
// Finds .image-toggle divs and sets up toggle behavior for images inside them
// Options via data attributes:
//   data-mode: manual|hover|scroll|both|steps
//   data-labels: comma-separated button labels
//   data-steps: CSS selector for step elements (used with mode="steps")
//   data-layout: sidebar (puts figure sticky on left, steps on right)
//
// Nested steps support:
//   Use .step-group divs containing .substep divs for collapsible groups
//   Groups auto-expand when scrolling into them and collapse when leaving

(function() {
  'use strict';

  function initImageToggle(container) {
    // Find all images inside the container (img or inline svg)
    const images = Array.from(container.querySelectorAll('img, svg'));
    if (images.length < 2) return; // Need at least 2 images to toggle
    
    const mode = container.dataset.mode || 'manual';
    const threshold = parseFloat(container.dataset.threshold) || 0.5;
    const labelsRaw = container.dataset.labels || '';
    const labels = labelsRaw ? labelsRaw.split(',').map(s => s.trim()) : [];
    const stepsSelector = container.dataset.steps || null;
    const layout = container.dataset.layout || null;
    
    // 'both' mode enables scroll and hover together
    const useScroll = (mode === 'scroll' || mode === 'both');
    const useHover = (mode === 'hover' || mode === 'both');
    const useSteps = (mode === 'steps') && stepsSelector;
    const useSidebar = (layout === 'sidebar') && stepsSelector;
    
    let currentIndex = 0;
    let autoEnabled = (useScroll || useHover || useSteps);

    // Find the wrapper div that contains the cells (aria-describedby div)
    const cellsWrapper = container.querySelector('[aria-describedby]');
    if (!cellsWrapper) return;
    
    // Find toggle frames: either wrapper divs containing .cell, or bare .cell divs
    // First, get direct children that contain images
    let cells = [];
    const directChildren = Array.from(cellsWrapper.children);
    
    for (const child of directChildren) {
      // Skip non-element nodes
      if (child.nodeType !== 1) continue;
      // If it's a div containing a .cell, use the div as the frame
      if (child.tagName === 'DIV' && child.querySelector('.cell')) {
        cells.push(child);
      }
      // If it's a bare .cell itself, use it
      else if (child.classList.contains('cell')) {
        cells.push(child);
      }
    }
    
    if (cells.length < 2) return;
    
    // Create the stack by wrapping cells
    const stack = document.createElement('div');
    stack.className = 'image-toggle-stack';
    
    // Move cells into the stack
    cells.forEach((cell, i) => {
      stack.appendChild(cell);
      cell.classList.add('image-toggle-cell');
      if (i === 0) {
        cell.classList.add('active');
      }
    });
    
    // Insert stack into the wrapper
    cellsWrapper.insertBefore(stack, cellsWrapper.firstChild);
    
    // Create controls
    const controls = document.createElement('div');
    controls.className = 'image-toggle-controls';
    
    cells.forEach((cell, i) => {
      const btn = document.createElement('button');
      btn.className = 'image-toggle-btn' + (i === 0 ? ' active' : '');
      btn.dataset.index = i;
      btn.textContent = labels[i] || `${i + 1}`;
      controls.appendChild(btn);
    });
    
    // Add figure label inline (from figcaption or id)
    const figcaption = container.querySelector('figcaption');
    const figureLabel = document.createElement('span');
    figureLabel.className = 'image-toggle-label';
    if (container.id) {
      // Extract figure number from quarto's auto-generated caption
      const captionMatch = figcaption?.textContent?.match(/Figure\s*[\d.]+/);
      figureLabel.textContent = captionMatch ? captionMatch[0] : '';
    }
    controls.appendChild(figureLabel);
    
    // Insert controls into each cell (will appear between map and table via CSS order)
    cells.forEach(cell => {
      const cellControls = controls.cloneNode(true);
      cellControls.style.order = '2';
      cell.appendChild(cellControls);
    });
    
    // Keep reference to all control sets for syncing
    const allControlSets = cells.map(cell => cell.querySelector('.image-toggle-controls'));
    
    // Toggle function
    function showCell(index) {
      if (index < 0 || index >= cells.length) return;
      
      cells.forEach((cell, i) => {
        cell.classList.toggle('active', i === index);
      });
      // Update buttons in all control sets
      allControlSets.forEach(ctrlSet => {
        ctrlSet.querySelectorAll('.image-toggle-btn').forEach((btn, i) => {
          btn.classList.toggle('active', i === index);
        });
      });
      currentIndex = index;
    }

    // Manual button clicks (attach to all control sets)
    allControlSets.forEach(ctrlSet => {
      ctrlSet.querySelectorAll('.image-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const index = parseInt(btn.dataset.index, 10);
          showCell(index);
          autoEnabled = false;
          setTimeout(() => { autoEnabled = (useScroll || useHover || useSteps); }, 3000);
        });
      });
    });

    // Scroll-triggered mode
    if (useScroll) {
      function onScroll() {
        if (!autoEnabled) return;
        
        const rect = container.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        
        if (rect.top < viewportHeight && rect.bottom > 0) {
          const progress = 1 - (rect.bottom / (viewportHeight + rect.height));
          const targetIndex = Math.min(
            Math.floor(progress * cells.length / threshold),
            cells.length - 1
          );
          
          if (targetIndex >= 0 && targetIndex !== currentIndex) {
            showCell(targetIndex);
          }
        }
      }

      let ticking = false;
      window.addEventListener('scroll', () => {
        if (!ticking) {
          requestAnimationFrame(() => {
            onScroll();
            ticking = false;
          });
          ticking = true;
        }
      }, { passive: true });
      
      onScroll();
    }

    // Hover-triggered mode
    if (useHover) {
      stack.addEventListener('mousemove', (e) => {
        if (!autoEnabled) return;
        
        const rect = stack.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const progress = x / rect.width;
        
        const targetIndex = Math.min(
          Math.floor(progress * cells.length),
          cells.length - 1
        );
        
        if (targetIndex >= 0 && targetIndex !== currentIndex) {
          showCell(targetIndex);
        }
      });
      
      stack.addEventListener('mouseleave', () => {
        if (autoEnabled) showCell(0);
      });
    }

    // Steps-triggered mode: transition based on which step element is in view
    if (useSteps) {
      let stepElements = Array.from(document.querySelectorAll(stepsSelector));
      let stepGroups = [];
      let flatSteps = []; // flat list mapping index -> {element, groupIndex}
      
      // Check for nested step groups
      const hasNestedGroups = stepElements.some(el => el.classList.contains('step-group'));
      
      if (hasNestedGroups) {
        // Build structure: groups contain substeps
        stepElements.forEach((el, groupIdx) => {
          if (el.classList.contains('step-group')) {
            const substeps = Array.from(el.querySelectorAll('.substep'));
            const header = el.querySelector('h3, h4, .step-group-header');
            stepGroups.push({
              element: el,
              header: header,
              substeps: substeps,
              startIndex: flatSteps.length
            });
            substeps.forEach(substep => {
              flatSteps.push({ element: substep, groupIndex: stepGroups.length - 1 });
            });
          } else {
            // Standalone step (not in a group)
            stepGroups.push({
              element: el,
              header: null,
              substeps: [el],
              startIndex: flatSteps.length
            });
            flatSteps.push({ element: el, groupIndex: stepGroups.length - 1 });
          }
        });
      } else {
        // No nested groups - treat all steps as flat
        stepElements.forEach((el, i) => {
          flatSteps.push({ element: el, groupIndex: -1 });
        });
      }
      
      // Sidebar layout: create wrapper with figure and steps side by side
      if (useSidebar && stepElements.length > 0) {
        const sidebar = document.createElement('div');
        sidebar.className = 'image-toggle-sidebar';
        
        // Figure column (the container itself)
        const figureCol = document.createElement('div');
        figureCol.className = 'image-toggle-figure';
        
        // Insert sidebar before container, then move container into it
        container.parentNode.insertBefore(sidebar, container);
        figureCol.appendChild(container);
        sidebar.appendChild(figureCol);
        
        // Steps column
        const stepsCol = document.createElement('div');
        stepsCol.className = 'image-toggle-steps';
        
        // Move step elements into the steps column
        stepElements.forEach(step => {
          stepsCol.appendChild(step);
        });
        sidebar.appendChild(stepsCol);
        
        // If we have nested groups, set up the collapsible structure
        if (hasNestedGroups) {
          stepGroups.forEach((group, groupIdx) => {
            if (group.header && group.substeps.length > 0) {
              // Add expand/collapse indicator to header
              const indicator = document.createElement('span');
              indicator.className = 'step-group-indicator';
              indicator.textContent = '▸';
              group.header.insertBefore(indicator, group.header.firstChild);
              
              // Create substeps container
              const substepsContainer = document.createElement('div');
              substepsContainer.className = 'step-group-substeps collapsed';
              group.substeps.forEach(substep => {
                substepsContainer.appendChild(substep);
              });
              group.element.appendChild(substepsContainer);
              group.substepsContainer = substepsContainer;
              group.indicator = indicator;
              
              // Make header clickable
              group.header.style.cursor = 'pointer';
              group.header.addEventListener('click', () => {
                toggleGroup(groupIdx);
              });
            }
          });
        }
      }
      
      let currentGroupIndex = -1;
      
      function toggleGroup(groupIdx, forceState = null) {
        stepGroups.forEach((group, i) => {
          if (!group.substepsContainer) return;
          
          const shouldExpand = forceState !== null 
            ? (i === groupIdx && forceState) 
            : (i === groupIdx && group.substepsContainer.classList.contains('collapsed'));
          
          if (i === groupIdx && (forceState === true || (forceState === null && group.substepsContainer.classList.contains('collapsed')))) {
            group.substepsContainer.classList.remove('collapsed');
            group.substepsContainer.classList.add('expanded');
            if (group.indicator) group.indicator.textContent = '▾';
          } else if (i !== groupIdx || forceState === false) {
            group.substepsContainer.classList.remove('expanded');
            group.substepsContainer.classList.add('collapsed');
            if (group.indicator) group.indicator.textContent = '▸';
          }
        });
      }
      
      function expandGroup(groupIdx) {
        if (groupIdx === currentGroupIndex) return;
        currentGroupIndex = groupIdx;
        stepGroups.forEach((group, i) => {
          if (!group.substepsContainer) return;
          if (i === groupIdx) {
            group.substepsContainer.classList.remove('collapsed');
            group.substepsContainer.classList.add('expanded');
            if (group.indicator) group.indicator.textContent = '▾';
          } else {
            group.substepsContainer.classList.remove('expanded');
            group.substepsContainer.classList.add('collapsed');
            if (group.indicator) group.indicator.textContent = '▸';
          }
        });
      }
      
      function onStepsScroll() {
        if (!autoEnabled) return;
        
        // Trigger point: higher (earlier) for non-sidebar since steps are shorter
        const viewportMiddle = useSidebar 
          ? window.innerHeight * 0.4 
          : window.innerHeight * 0.7;
        
        // Find which step is closest to the trigger point
        let targetIndex = 0;
        const stepsToCheck = hasNestedGroups ? flatSteps : stepElements.map((el, i) => ({ element: el }));
        
        for (let i = 0; i < stepsToCheck.length && i < cells.length; i++) {
          const rect = stepsToCheck[i].element.getBoundingClientRect();
          if (rect.top < viewportMiddle) {
            targetIndex = i;
          }
        }
        
        // Update figure
        if (targetIndex !== currentIndex) {
          showCell(targetIndex);
        }
        
        // Update group expansion if using nested groups
        if (hasNestedGroups && flatSteps[targetIndex]) {
          const targetGroupIndex = flatSteps[targetIndex].groupIndex;
          expandGroup(targetGroupIndex);
          
          // Highlight current substep
          flatSteps.forEach((step, i) => {
            step.element.classList.toggle('active-step', i === targetIndex);
          });
        }
      }

      let ticking = false;
      window.addEventListener('scroll', () => {
        if (!ticking) {
          requestAnimationFrame(() => {
            onStepsScroll();
            ticking = false;
          });
          ticking = true;
        }
      }, { passive: true });
      
      onStepsScroll();
    }
  }

  function initAll() {
    document.querySelectorAll('.image-toggle').forEach(initImageToggle);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
