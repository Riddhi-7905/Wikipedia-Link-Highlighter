// ==UserScript==
// @name         Smart Highlight (Wikipedia-safe)
// @description  Highlights unlinked phrases that already have Wikipedia articles (no AI)
// @version      2.0
// @match        *://*.wikipedia.org/wiki/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ================= CONFIG ================= */
  const MAX_HIGHLIGHTS = 40;
  const MAX_PHRASE_WORDS = 4;
  const API_BATCH_SIZE = 20;

  /* ================= GUARDS ================= */
  if (mw.config.get('wgNamespaceNumber') !== 0) return;
  const content = document.getElementById('mw-content-text');
  if (!content) return;

  console.log('[SmartHL] Started');

  /* ================= STYLES ================= */
  injectStyle();

  /* ================= MAIN ================= */
  const linkedTexts = collectLinkedTexts(content);
  const candidates = extractCandidatePhrases(content.innerText);
  const filtered = candidates.filter(t => !linkedTexts.has(t));

  console.log('[SmartHL] Candidates:', filtered.length);

  validateViaAPI(filtered).then(validTitles => {
    console.log('[SmartHL] Valid titles:', validTitles.length);
    highlightTerms(content, validTitles.slice(0, MAX_HIGHLIGHTS));
  });

  /* ================= FUNCTIONS ================= */

  function extractCandidatePhrases(text) {
    const regex = new RegExp(
      `\\b([A-Z][a-z]+(?:\\s[A-Z][a-z]+){0,${MAX_PHRASE_WORDS - 1}})\\b`,
      'g'
    );

    const raw = text.match(regex) || [];
    return Array.from(new Set(raw))
      .filter(p => p.split(' ').length > 1 || p.length > 4);
  }

  function collectLinkedTexts(root) {
    return new Set(
      Array.from(root.querySelectorAll('a'))
        .map(a => a.textContent.trim())
        .filter(Boolean)
    );
  }

  async function validateViaAPI(phrases) {
    const valid = new Set();
    const api = mw.util.wikiScript('api');

    for (let i = 0; i < phrases.length; i += API_BATCH_SIZE) {
      const batch = phrases.slice(i, i + API_BATCH_SIZE);

      const params = new URLSearchParams({
        action: 'query',
        format: 'json',
        redirects: '1',
        titles: batch.join('|'),
        prop: 'pageprops'
      });

      const res = await fetch(`${api}?${params}`);
      const data = await res.json();

      Object.values(data.query.pages).forEach(p => {
        if (p.missing) return;
        if (p.pageprops && p.pageprops.disambiguation) return;
        valid.add(p.title);
      });
    }
    return Array.from(valid);
  }

  function highlightTerms(root, terms) {
    if (!terms.length) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.parentElement) return NodeFilter.FILTER_REJECT;
        if (node.parentElement.closest('a, sup, .reference, .infobox, .thumb')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let count = 0;

    while (walker.nextNode() && count < MAX_HIGHLIGHTS) {
      const node = walker.currentNode;
      let text = node.textContent;

      for (const title of terms) {
        const regex = new RegExp(`\\b${escapeRegExp(title)}\\b`);
        if (!regex.test(text)) continue;

        const span = document.createElement('span');
        span.innerHTML = text.replace(
          regex,
          `<mark class="smarthl" data-title="${title}" title="Click to link [[${title}]]">${title}</mark>`
        );

        node.parentNode.replaceChild(span, node);
        count++;
        break;
      }
    }

    enableClickToLink();
    console.log('[SmartHL] Highlights inserted:', count);
  }

  function enableClickToLink() {
    document.querySelectorAll('mark.smarthl').forEach(m => {
      m.addEventListener('click', e => {
        e.stopPropagation();
        const title = m.dataset.title;
        m.outerHTML = `[[${title}]]`;
      });
    });
  }

  function injectStyle() {
    const style = document.createElement('style');
    style.textContent = `
      mark.smarthl {
        background: #fff3b0;
        border-bottom: 2px dotted #e67e22;
        cursor: pointer;
        padding: 0 2px;
        border-radius: 2px;
      }
      mark.smarthl:hover {
        background: #ffe08a;
      }
    `;
    document.head.appendChild(style);
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

})();
