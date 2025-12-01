// ==UserScript==
// @name         Highlight Unlinked Existing Terms (Improved)
// @description  Highlights proper unlinked terms that already have their own Wikipedia articles.
// @version      1.2
// @author       Riddhi Sharma/Herdaisymione
// @match        *://*.wikipedia.org/wiki/*
// ==/UserScript==

mw.hook && mw.hook('wikipage.content').add(init);
(function(){ if (!mw.hook) init(); })();

function init($content) {
  const contentElem = $content && $content[0] ? $content[0] : document.getElementById('mw-content-text');
  if (!contentElem) return;

  // Only run on Wikipedia article pages
  if (!location.hostname.includes('wikipedia.org')) return;
  if (mw.config.get('wgNamespaceNumber') !== 0 || mw.config.get('wgAction') !== 'view') return;

  const API_BATCH = 40;

  // Add red highlight style
  const style = document.createElement('style');
  style.textContent = `
    .riddhi-unlinked-term {
      background-color: #ffecec;
      color: #b30000;
      border-radius: 3px;
      padding: 1px 3px;
      cursor: help;
      border-bottom: 1px dotted rgba(179,0,0,0.4);
    }
    .riddhi-unlinked-term:hover {
      background-color: #ffd6d6;
    }
  `;
  document.head.appendChild(style);

  const pageTitle = mw.config.get('wgTitle').replace(/_/g, ' ').toLowerCase();

  // collect visible text nodes
  function collectTextNodes(root, nodes = []) {
    for (const node of root.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent.trim().length > 0) nodes.push(node);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;
        if (["A","SUP","SUB","CITE","STYLE","SCRIPT","TABLE","IMG","FIGURE","H1","H2","H3","H4","H5","H6"].includes(tag)) continue;
        if (node.classList && (
            node.classList.contains('infobox') ||
            node.classList.contains('navbox') ||
            node.classList.contains('reflist') ||
            node.classList.contains('metadata') ||
            node.classList.contains('thumb')
        )) continue;
        collectTextNodes(node, nodes);
      }
    }
    return nodes;
  }

  const textNodes = collectTextNodes(contentElem);

  // Detect proper-looking terms (multi-word capitalized or proper nouns)
  const termRegex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g;

  const candidates = new Set();
  for (const n of textNodes) {
    let match;
    while ((match = termRegex.exec(n.textContent)) !== null) {
      const term = match[1].trim();
      const lower = term.toLowerCase();
      if (lower.length < 3) continue;
      if (pageTitle.includes(lower)) continue; // skip words from article title
      candidates.add(term);
    }
  }

  // Remove already linked words
  const linkedTexts = new Set(Array.from(contentElem.querySelectorAll('a')).map(a => a.textContent.trim()).filter(Boolean));
  const toCheck = Array.from(candidates).filter(t => !linkedTexts.has(t));

  if (toCheck.length === 0) return;

  const api = new mw.Api();
  const promises = [];
  for (let i = 0; i < toCheck.length; i += API_BATCH) {
    promises.push(api.get({
      action: "query",
      format: "json",
      formatversion: 2,
      redirects: 1,
      titles: toCheck.slice(i, i + API_BATCH).join("|"),
      prop: "pageprops",
      ppprop: "disambiguation"
    }));
  }

  Promise.all(promises).then(results => {
    const existing = new Set();
    results.forEach(r => {
      (r.query && r.query.pages || []).forEach(p => {
        if (p.missing || p.pageprops?.disambiguation !== undefined) return;
        existing.add(p.title);
      });
    });

    if (existing.size === 0) return;

    // Highlight matches in the visible text
    textNodes.forEach(node => {
      const text = node.textContent;
      let replaced = text;
      existing.forEach(term => {
        const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "g");
        replaced = replaced.replace(regex, `<span class="riddhi-unlinked-term" title="This term has an article — consider linking it.">${term}</span>`);
      });
      if (replaced !== text) {
        const span = document.createElement("span");
        span.innerHTML = replaced;
        node.replaceWith(span);
      }
    });
  });
}

