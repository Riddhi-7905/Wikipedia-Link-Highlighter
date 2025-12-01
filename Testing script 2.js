// ==UserScript==
// @name         Highlight Unlinked Existing Terms (fixed v2)
// @description  Highlights words in Wikipedia articles that are not linked but already have their own articles.
// @version      1.1
// @author       Riddhi/Herdaisymione
// @match        *://*.wikipedia.org/wiki/*
// ==/UserScript==

/*
  Behavior:
  - Runs only on wikipedia.org article pages (namespace 0, view)
  - Finds candidate 1-3 word terms (each word >= 3 chars)
  - Filters out common stopwords and terms already linked on the page
  - Uses the site's API to check which terms correspond to existing articles (not disambiguation)
  - Highlights each found term once with a red marker and tooltip suggesting [[Term]]
*/

mw.hook && mw.hook('wikipage.content').add(init);
(function(){ if (!mw.hook) init(); })();

function init($content) {
  const contentElem = $content && $content[0] ? $content[0] : document.getElementById('mw-content-text');
  if (!contentElem) return;

  // Only run on wikipedia.org domains (not meta.wikimedia.org) & only on main namespace view
  if (!location.hostname.includes('wikipedia.org')) return;
  if (mw.config.get('wgNamespaceNumber') !== 0 || mw.config.get('wgAction') !== 'view') return;

  const API_BATCH = 50;

  // Add red highlight style
  const style = document.createElement('style');
  style.textContent = `
    .riddhi-unlinked-term {
      background-color: #ffecec;
      color: #b30000;
      border-radius: 3px;
      padding: 1px 3px;
      cursor: help;
      border-bottom: 1px solid rgba(179,0,0,0.2);
    }
    .riddhi-unlinked-term:hover { background-color: #ffd6d6; }
  `;
  document.head.appendChild(style);

  // Collect visible text nodes (skip tags likely to contain links or not relevant)
  function collectTextNodes(root, nodes = []) {
    for (const node of root.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent.trim().length > 0) nodes.push(node);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;
        // skip elements that commonly contain links or non-article text
        if (["A","SUP","SUB","CITE","STYLE","SCRIPT","MARK","TABLE","IMG","FIGURE","CODE","PRE"].includes(tag)) continue;
        if (node.classList && (
            node.classList.contains('infobox') ||
            node.classList.contains('navbox') ||
            node.classList.contains('reflist') ||
            node.classList.contains('metadata') ||
            node.classList.contains('mw-references-wrap') ||
            node.classList.contains('thumb') ||
            node.classList.contains('vertical-navbox')
        )) continue;
        collectTextNodes(node, nodes);
      }
    }
    return nodes;
  }

  // Make a clone for safe candidate detection (remove big boxes)
  const clone = contentElem.cloneNode(true);
  clone.querySelectorAll('.infobox, .wikitable, .reflist, .navbox, .metadata, .thumb, .vertical-navbox').forEach(e => e.remove());

  const candidateNodes = collectTextNodes(clone);
  const pageTextNodes = collectTextNodes(contentElem);

  // Regex: 1-3 words, each word at least 3 characters (Unicode letters, hyphen, apostrophe)
  const candidateRegex = /\b(?:[A-Za-zÀ-ž'’\-]{3,})(?:\s+(?:[A-Za-zÀ-ž'’\-]{3,})){0,2}\b/g;

  // Minimal blacklist of stopwords (lowercase)
  const blacklist = new Set([
    "the","and","for","are","was","were","with","from","this","that","these","those",
    "about","which","their","there","other","also","than","then","such","have","into",
    "after","before","during","within","among","between","through","over","under"
  ]);

  // Gather candidate strings
  const candidates = new Set();
  candidateNodes.forEach(n => {
    const matches = n.textContent.match(candidateRegex);
    if (!matches) return;
    matches.forEach(m => {
      const normalized = m.trim();
      if (!normalized) return;
      if (/^\d+$/.test(normalized)) return; // ignore pure numbers
      if (blacklist.has(normalized.toLowerCase())) return;
      candidates.add(normalized);
    });
  });

  if (candidates.size === 0) return;

  // Build set of texts already used inside links on the page (exact text matches)
  const linkedTexts = new Set();
  Array.from(contentElem.querySelectorAll('a')).forEach(a => {
    const t = a.textContent.trim();
    if (t) linkedTexts.add(t);
  });

// Filter candidates to those not already linked
  const toCheck = Array.from(candidates).filter(term => !linkedTexts.has(term));
  if (toCheck.length === 0) return;

  // Query the wiki API in batches to check existence (skip disambiguation)
  const api = new mw.Api();
  const promises = [];
  for (let i = 0; i < toCheck.length; i += API_BATCH) {
    const chunk = toCheck.slice(i, i + API_BATCH);
    promises.push(api.get({
      action: "query",
      format: "json",
      formatversion: 2,
      redirects: 1,
      titles: chunk.join("|"),
      prop: "pageprops",
      ppprop: "disambiguation"
    }));
  }

  Promise.all(promises).then(results => {
    const existing = new Set();
    results.forEach(r => {
      if (!r.query || !r.query.pages) return;
      // capture redirects info if present
      const redirects = (r.query.redirects) ? r.query.redirects : [];
      r.query.pages.forEach(p => {
        if (!p.missing && !p.pageprops?.disambiguation) {
          existing.add(p.title);
          // add any redirect-from titles in this response that point to this page
          redirects.forEach(rd => {
            if (rd.to === p.title) existing.add(rd.from);
          });
        }
      });
    });

    if (existing.size === 0) return;

    // Sort existing terms by length descending so multi-word matches try first
    const existingList = Array.from(existing).sort((a,b) => b.length - a.length).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (existingList.length === 0) return;

    const termRE = new RegExp(`\\b(${existingList.join('|')})\\b`, 'g');

    const alreadyHighlighted = new Set();

    pageTextNodes.forEach(node => {
      if (!node.parentElement) return;
      // skip nodes that are within ignored parents
      if (node.parentElement.closest('a, sup, cite, .infobox, .reflist, .navbox, .thumb')) return;

      const original = node.textContent;
      let lastIndex = 0;
      let m;
      let changed = false;
      const frag = document.createDocumentFragment();

      while ((m = termRE.exec(original)) !== null) {
        const term = m[0];

        // Confirm term is in existing set
        if (!existing.has(term)) continue;
        // Don't highlight the same term more than once
        if (alreadyHighlighted.has(term)) continue;
        // Double-check no link with exact text exists (safety)
        if (Array.from(contentElem.querySelectorAll('a')).some(a => a.textContent.trim() === term)) continue;

        // Append text before match
        frag.appendChild(document.createTextNode(original.slice(lastIndex, m.index)));

        // Create marker
        const span = document.createElement('span');
        span.className = 'riddhi-unlinked-term';
        span.textContent = term;
        span.title = `This term has an article on this wiki. Consider adding [[${term}]] if it's relevant.`;
        frag.appendChild(span);

        alreadyHighlighted.add(term);
        changed = true;
        lastIndex = m.index + term.length;
      }

      if (changed) {
        // Append remaining text after the last match
        frag.appendChild(document.createTextNode(original.slice(lastIndex)));
        node.replaceWith(frag);
      }
    });

  }).catch(err => {
    console.error('Highlight script error:', err);
  });
}
