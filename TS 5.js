// ==UserScript==
// @name         Highlight Unlinked Existing Terms (Improved)
// @description  Highlights unlinked words in Wikipedia articles that already have their own pages.
// @version      1.4
// @author       Riddhi / Herdaisymione
// @match        *://*.wikipedia.org/wiki/*
// ==/UserScript==

(function () {
  'use strict';
  // Only run on article pages (namespace 0)
  if (mw.config.get('wgNamespaceNumber') !== 0 || mw.config.get('wgAction') !== 'view') return;

  // Add styles for highlighted terms
  const style = document.createElement('style');
  style.textContent = `
    .riddhi-unlinked-term {
      background-color: #fff2cc;
      color: #d35400;
      border-radius: 3px;
      padding: 1px 3px;
      cursor: help;
      border-bottom: 1px dotted #e67e22;
    }
    .riddhi-unlinked-term:hover::after {
      content: "✔️ This word already has an article";
      background: #fff8e6;
      border: 1px solid #e67e22;
      border-radius: 5px;
      padding: 3px 6px;
      position: absolute;
      z-index: 9999;
      font-size: 12px;
      color: #333;
      margin-left: 5px;
    }
  `;
  document.head.appendChild(style);

  const API_BATCH = 40;
  const blacklist = new Set([
    "the", "and", "for", "are", "was", "were", "with", "from", "this", "that", "these", "those",
    "about", "which", "their", "there", "other", "also", "than", "then", "such", "have", "into",
    "after", "before", "when", "what", "where", "who", "why", "how", "one", "two", "three", "said"
  ]);

  const contentElem = document.getElementById('mw-content-text');
  if (!contentElem) return;

  // Collect visible text nodes, skipping unwanted elements
  function collectTextNodes(root, nodes = []) {
    for (const node of root.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent.trim().length > 0) nodes.push(node);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;
        if (["A", "SUP", "SUB", "CITE", "TABLE", "STYLE", "SCRIPT", "IMG", "FIGURE"].includes(tag)) continue;
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

  const nodes = collectTextNodes(contentElem);
  const regex = /\b[A-Z]?[a-z][a-z\-']{2,}(?:\s+[A-Z]?[a-z][a-z\-']{2,}){0,2}\b/g;
  const candidates = new Set();

  nodes.forEach(n => {
    const matches = n.textContent.match(regex);
    if (matches) {
      matches.forEach(m => {
        const t = m.trim();
        if (!t) return;
        if (/^\d+$/.test(t)) return;
        if (blacklist.has(t.toLowerCase())) return;
        candidates.add(t);
      });
    }
  });

  // Filter out terms already linked in the page
  const linkedTexts = new Set(Array.from(contentElem.querySelectorAll('a')).map(a => a.textContent.trim()));
  const toCheck = Array.from(candidates).filter(term => !linkedTexts.has(term));
  if (!toCheck.length) return;

  const api = new mw.Api();
  const promises = [];
  for (let i = 0; i < toCheck.length; i += API_BATCH) {
    const chunk = toCheck.slice(i, i + API_BATCH);
    promises.push(api.get({
      action: "query",
      format: "json",
      formatversion: 2,
      redirects: 1,
      titles: chunk.join("|")
    }));
  }

  Promise.all(promises).then(results => {
    const existing = new Set();
    results.forEach(r => {
      if (r.query && r.query.pages) {
        r.query.pages.forEach(p => {
          if (p.missing !== true) existing.add(p.title);
        });
      }
    });

    if (!existing.size) return;
    const walker = document.createTreeWalker(contentElem, NodeFilter.SHOW_TEXT, null, false);

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent;
      let replaced = text;
      existing.forEach(term => {
        const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\b${esc}\\b`, "g");
        replaced = replaced.replace(re, `<span class="riddhi-unlinked-term">${term}</span>`);
      });
      if (replaced !== text) {
        const span = document.createElement('span');
        span.innerHTML = replaced;
        node.replaceWith(span);
      }
    }
  });
})();

