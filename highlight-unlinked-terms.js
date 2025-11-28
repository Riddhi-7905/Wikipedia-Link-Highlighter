// ==UserScript==
// @name         Smart Highlight (Debug + Fallback)
// @description  Highlights related or unlinked capitalized terms with visible logs
// @version      1.7
// @match        *://*.wikipedia.org/wiki/*
// ==/UserScript==

(function () {
  'use strict';
  const MAX_HIGHLIGHTS = 50;
  console.log('[SmartHL] Script started');

  if (mw.config.get('wgNamespaceNumber') !== 0) return console.log('[SmartHL] Not a main article');
  const content = document.getElementById('mw-content-text');
  if (!content) return console.log('[SmartHL] No content area');

  // Simple fallback: highlight unlinked capitalized words
  const allText = content.innerText;
  const capitalWords = Array.from(new Set(allText.match(/\b[A-Z][a-z]{3,}\b/g))) || [];
  console.log('[SmartHL] Found capitalized words:', capitalWords.length);

  const linkedWords = new Set(Array.from(content.querySelectorAll('a')).map(a => a.textContent.trim()));
  const filtered = capitalWords.filter(w => !linkedWords.has(w)).slice(0, MAX_HIGHLIGHTS);
  console.log('[SmartHL] Highlighting (fallback) words:', filtered.length);

  injectStyle();
  highlightTerms(content, filtered);

  // --- helper functions ---
  function injectStyle() {
    const style = document.createElement('style');
    style.textContent = `
      mark.smarthl {
        background-color: rgba(255, 0, 0, 0.3);
        cursor: pointer;
        padding: 0 2px;
        border-radius: 2px;
      }
    `;
    document.head.appendChild(style);
  }

  function highlightTerms(root, terms) {
    if (!terms.length) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        if (!node.parentElement) return NodeFilter.FILTER_REJECT;
        if (node.parentElement.closest('a, sup, .reference, .infobox, .thumb')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let count = 0;
    while (walker.nextNode() && count < MAX_HIGHLIGHTS) {
      const node = walker.currentNode;
      let text = node.textContent;
      for (const t of terms) {
        const regex = new RegExp(`\\b${t}\\b`, 'g');
        if (regex.test(text)) {
          const spanHTML = text.replace(regex, `<mark class="smarthl" title="Consider linking [[${t}]]">${t}</mark>`);
          const span = document.createElement('span');
          span.innerHTML = spanHTML;
          node.parentNode.replaceChild(span, node);
          count++;
          break;
        }
      }
    }
    console.log('[SmartHL] Highlights inserted:', count);
  }
})();
