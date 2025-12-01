// ==UserScript==
// @name         Highlight Unlinked Existing Terms
// @description  Highlights words in Wikipedia articles that are not linked but already have their own articles.
// @version      1.0
// @author       Riddhi
// @match        *://*.wikipedia.org/wiki/*
// ==/UserScript==

(function () {
  'use strict';

  // ---- STEP 1: Select article text area ----
  const content = document.getElementById('mw-content-text');
  if (!content) return;

  // ---- STEP 2: Extract visible text ----
  const paragraphs = content.querySelectorAll('p');
  const words = new Set();

  // ---- STEP 3: Gather candidate words ----
  paragraphs.forEach(p => {
    // skip text inside links
    const text = p.innerText;
    const matches = text.match(/\b[A-Za-zÀ-ž][A-Za-zÀ-ž\-]{2,}\b/g);
    if (matches) {
      matches.forEach(word => {
        // ignore short/common words
        if (word.length > 2 && !/^(and|the|for|are|was|were|with|from|this|that|these|those)$/i.test(word)) {
          words.add(word);
        }
      });
    }
  });

  // ---- STEP 4: Check which words have articles ----
  const checkWordExists = async (word) => {
    const apiUrl = `/w/api.php?action=query&titles=${encodeURIComponent(word)}&format=json&origin=*`;
    const response = await fetch(apiUrl);
    const data = await response.json();
    const pages = data.query.pages;
    const page = Object.values(pages)[0];
    return !(page.missing || page.invalid);
  };

  // ---- STEP 5: Highlight existing, unlinked words ----
  const highlightWord = (node, word) => {
    const regex = new RegExp(`\\b(${word})\\b`, 'gi');
    const newHtml = node.innerHTML.replace(regex, (match) => {
      // Skip if already inside a link
      if (/<a [^>]*>/.test(node.innerHTML)) return match;
      return `<span class="highlight-term" title="This term has an article. Consider linking it with [[${match}]].">${match}</span>`;
    });
    node.innerHTML = newHtml;
  };

  // ---- STEP 6: Style for highlighting ----
  const style = document.createElement('style');
  style.textContent = `
    .highlight-term {
      background-color: #ffe6e6;
      color: red;
      cursor: help;
      border-radius: 3px;
      padding: 1px 3px;
    }
    .highlight-term:hover {
      background-color: #ffcccc;
    }
  `;
  document.head.appendChild(style);

  // ---- STEP 7: Process words in batches ----
  (async () => {
    for (const word of words) {
      const exists = await checkWordExists(word);
      if (exists) {
        paragraphs.forEach(p => highlightWord(p, word));
      }
    }
  })();

})();
