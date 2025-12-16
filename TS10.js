// ==UserScript==
// @name         Wikipedia Smart Linker (No-AI)
// @description  Verifies unlinked capitalized words against Wikipedia API before highlighting
// @version      2.0
// @match        *://*.wikipedia.org/wiki/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const MAX_QUERY_SIZE = 50; // MediaWiki API limit for titles
    const MIN_WORD_LENGTH = 4;

    console.log('[SmartHL] Initializing Verification Engine...');

    if (mw.config.get('wgNamespaceNumber') !== 0) return;

    const content = document.querySelector('.mw-parser-output');
    if (!content) return;

    injectStyle();

    // 1. Extract candidates (Capitalized words not already linked)
    const existingLinks = new Set(Array.from(content.querySelectorAll('a')).map(a => a.textContent.trim()));
    const text = content.innerText;
    const candidates = Array.from(new Set(text.match(/\b[A-Z][a-z]+\b/g)))
        .filter(w => w.length >= MIN_WORD_LENGTH && !existingLinks.has(w));

    if (candidates.length === 0) return console.log('[SmartHL] No candidates found.');

    // 2. Process candidates in batches of 50 to respect API limits
    processBatches(candidates);

    async function processBatches(list) {
        for (let i = 0; i < list.length; i += MAX_QUERY_SIZE) {
            const batch = list.slice(i, i + MAX_QUERY_SIZE);
            const verifiedTitles = await verifyWithWikipedia(batch);
            if (verifiedTitles.length > 0) {
                highlightTerms(content, verifiedTitles);
            }
        }
    }

    // 3. The "Truth" Source: MediaWiki API
    async function verifyWithWikipedia(titles) {
        const params = new URLSearchParams({
            action: 'query',
            titles: titles.join('|'),
            format: 'json',
            redirects: 1,
            origin: '*'
        });

        try {
            const response = await fetch(`${mw.util.wikiScript('api')}?${params.toString()}`);
            const data = await response.json();
            
            if (!data.query || !data.query.pages) return [];

            // Filter out pages that are "missing" (don't exist)
            const valid = Object.values(data.query.pages)
                .filter(p => !p.missing)
                .map(p => {
                    // We want to match the original word typed, but know the real title
                    return { found: p.title, exists: true };
                });
            
            return valid.map(v => v.found);
        } catch (err) {
            console.error('[SmartHL] API Error:', err);
            return [];
        }
    }

    function highlightTerms(root, terms) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: node => {
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                // Avoid breaking existing links, citations, or metadata
                if (parent.closest('a, sup, .reference, .infobox, .thumb, .metadata, table')) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);

        nodes.forEach(node => {
            let text = node.textContent;
            let modified = false;

            // Sort terms by length (descending) to avoid partial matching errors
            terms.sort((a, b) => b.length - a.length).forEach(t => {
                const regex = new RegExp(`\\b(${t})\\b`, 'g');
                if (regex.test(text)) {
                    // Wrap in [[ ]] style syntax and our highlight class
                    text = text.replace(regex, `<mark class="smarthl" title="Existing Article: [[$1]]">[[$1]]</mark>`);
                    modified = true;
                }
            });

            if (modified) {
                const span = document.createElement('span');
                span.innerHTML = text;
                node.parentNode.replaceChild(span, node);
            }
        });
    }

    function injectStyle() {
        const style = document.createElement('style');
        style.textContent = `
            mark.smarthl {
                background-color: rgba(52, 152, 219, 0.2);
                border-bottom: 1px dotted #3498db;
                color: inherit;
                cursor: help;
                transition: background 0.2s;
            }
            mark.smarthl:hover {
                background-color: rgba(52, 152, 219, 0.4);
            }
        `;
        document.head.appendChild(style);
    }
})();
