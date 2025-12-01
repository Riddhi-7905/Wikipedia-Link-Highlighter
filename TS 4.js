// ==UserScript==
// @name         Highlight Unlinked Existing Terms (Smart Version)
// @description  Highlights unlinked, meaningful terms in Wikipedia articles that already have their own pages
// @version      1.3
// @author       Riddhi / Herdaisymione
// @match        *://*.wikipedia.org/wiki/*
// ==/UserScript==

mw.hook && mw.hook("wikipage.content").add(init);
(function(){ if(!mw.hook) init(); })();

function init($content) {
  const contentElem = $content && $content[0] ? $content[0] : document.getElementById("mw-content-text");
  if (!contentElem) return;

  // run only in article namespace
  if (mw.config.get("wgNamespaceNumber") !== 0 || mw.config.get("wgAction") !== "view") return;

  // skip meta.wikimedia etc
  if (!location.hostname.includes("wikipedia.org")) return;

  const API_BATCH = 50;

  // === Styles ===
  const style = document.createElement("style");
  style.textContent = `
    .riddhi-unlinked-term {
      background-color: #ffe6e6;
      color: #b30000;
      border-radius: 3px;
      padding: 1px 3px;
      cursor: help;
      border-bottom: 1px solid rgba(179,0,0,0.3);
      transition: background-color 0.2s;
    }
    .riddhi-unlinked-term:hover {
      background-color: #ffcccc;
    }
  `;
  document.head.appendChild(style);

  // === Collect text nodes ===
  function collectTextNodes(root, nodes = []) {
    for (const node of root.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent.trim().length > 0) nodes.push(node);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;
        if (["A","SUP","SUB","CITE","STYLE","SCRIPT","MARK","TABLE","IMG","FIGURE"].includes(tag)) continue;
        if (node.classList && (
            node.classList.contains("infobox") ||
            node.classList.contains("navbox") ||
            node.classList.contains("reflist") ||
            node.classList.contains("metadata") ||
            node.classList.contains("thumb")
        )) continue;
        collectTextNodes(node, nodes);
      }
    }
    return nodes;
  }

  const clone = contentElem.cloneNode(true);
  clone.querySelectorAll(".infobox, .wikitable, .reflist, .navbox, .metadata, .thumb").forEach(e => e.remove());
  const candidateNodes = collectTextNodes(clone);
  const pageTextNodes = collectTextNodes(contentElem);

  // === Find candidate terms ===
  const blacklist = new Set([
    "The","This","That","These","Those","When","Where","Which","While",
    "Before","After","Because","During","However","Although","Also","As",
    "For","From","Was","Were","Are","Is","Be","Have","Had","Has","Into","On",
    "At","Of","And","Or","In","It","Its","Their","There","Then","Than","Other",
    "About","Such","With","An","A"
  ]);

  // Multi-word proper noun pattern: up to 3 capitalized words
  const termRegex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g;

  const candidates = new Set();
  candidateNodes.forEach(n => {
    const matches = n.textContent.match(termRegex);
    if (matches) {
      matches.forEach(m => {
        const clean = m.trim();
        if (!clean) return;
        if (blacklist.has(clean)) return;
        // ignore if all caps (like TV)
        if (/^[A-Z]{2,}$/.test(clean)) return;
        candidates.add(clean);
      });
    }
  });

  if (candidates.size === 0) return;

  // === Filter already linked ===
  const linked = new Set();
  contentElem.querySelectorAll("a").forEach(a => {
    const text = a.textContent.trim();
    if (text) linked.add(text);
  });

  const toCheck = Array.from(candidates).filter(t => !linked.has(t));
  if (toCheck.length === 0) return;

  // === Check via API if those titles exist ===
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
    results.forEach(data => {
      if (!data.query || !data.query.pages) return;
      data.query.pages.forEach(page => {
        if (!page.missing && !page.pageprops?.disambiguation) {
          existing.add(page.title);
        }
      });
    });

    if (existing.size === 0) return;

    const escaped = Array.from(existing)
      .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (escaped.length === 0) return;

    const regex = new RegExp(`\\b(${escaped.join("|")})\\b`, "g");

    pageTextNodes.forEach(node => {
      if (node.parentElement.closest("A, SUP, CITE, MARK, .infobox, .navbox")) return;
      const text = node.textContent;
      let lastIndex = 0;
      let match;
      let changed = false;
      const frag = document.createDocumentFragment();

      while ((match = regex.exec(text)) !== null) {
        const term = match[0];
        if (!existing.has(term)) continue;
        changed = true;
        frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        const mark = document.createElement("mark");
        mark.className = "riddhi-unlinked-term";
        mark.textContent = term;
        mark.title = `An article exists for “${term}”. Consider linking it.`;
        frag.appendChild(mark);
        lastIndex = match.index + term.length;
      }

      if (changed) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex)));
        node.replaceWith(frag);
      }
    });
  });
}

