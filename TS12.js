// ==UserScript==
// @name         Wikipedia Article Word Highlighter
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Highlight words in Wikipedia articles that have existing Wikipedia pages
// @match        https://*.wikipedia.org/wiki/*
// @grant        GM_xmlhttpRequest
// @connect      *.wikipedia.org
// ==/UserScript==

(function() {
    'use strict';

    // Configuration
    const CONFIG = {
        minWordLength: 4,
        maxWordsToCheck: 100,
        highlightColor: '#ffeb3b',
        checkInterval: 500
    };

    // Store found Wikipedia terms
    let wikiTerms = new Set();
    let processedWords = new Set();
    let isProcessing = false;

    // Get the current article title
    function getCurrentArticleTitle() {
        const title = document.getElementById('firstHeading');
        return title ? title.textContent.trim() : '';
    }

    // Extract links from the current page
    function extractExistingLinks() {
        const contentDiv = document.getElementById('mw-content-text');
        if (!contentDiv) return;

        const links = contentDiv.querySelectorAll('a[href^="/wiki/"]:not([href*=":"])');
        links.forEach(link => {
            const href = link.getAttribute('href');
            const term = decodeURIComponent(href.replace('/wiki/', '')).replace(/_/g, ' ');
            wikiTerms.add(term.toLowerCase());
        });

        console.log(`Extracted ${wikiTerms.size} existing Wikipedia terms`);
    }

    // Fetch related articles from "See also" section
    async function fetchRelatedTerms() {
        const seeAlsoSection = Array.from(document.querySelectorAll('.mw-heading2, .mw-heading3, h2, h3'))
            .find(h => h.textContent.trim().match(/see also|related/i));

        if (seeAlsoSection) {
            let nextEl = seeAlsoSection.nextElementSibling;
            while (nextEl && nextEl.tagName === 'UL') {
                const links = nextEl.querySelectorAll('a[href^="/wiki/"]:not([href*=":"])');
                links.forEach(link => {
                    const href = link.getAttribute('href');
                    const term = decodeURIComponent(href.replace('/wiki/', '')).replace(/_/g, ' ');
                    wikiTerms.add(term.toLowerCase());
                });
                nextEl = nextEl.nextElementSibling;
            }
        }
    }

    // Check if a Wikipedia page exists for a term
    function checkWikipediaPage(term) {
        return new Promise((resolve) => {
            if (processedWords.has(term.toLowerCase())) {
                resolve(wikiTerms.has(term.toLowerCase()));
                return;
            }

            const apiUrl = `${window.location.origin}/w/api.php?action=query&titles=${encodeURIComponent(term)}&format=json&origin=*`;

            GM_xmlhttpRequest({
                method: 'GET',
                url: apiUrl,
                onload: function(response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        const pages = data.query.pages;
                        const pageId = Object.keys(pages)[0];
                        const exists = pageId !== '-1';

                        processedWords.add(term.toLowerCase());
                        if (exists) {
                            wikiTerms.add(term.toLowerCase());
                        }
                        resolve(exists);
                    } catch (e) {
                        resolve(false);
                    }
                },
                onerror: function() {
                    resolve(false);
                }
            });
        });
    }

    // Extract meaningful words from paragraphs
    function extractCandidateWords(text) {
        // Remove existing wiki markup
        text = text.replace(/\[\[.*?\]\]/g, '');

        // Extract words (including multi-word phrases up to 3 words)
        const words = new Set();
        
        // Single words
        const singleWords = text.match(/\b[A-Z][a-z]{3,}\b/g) || [];
        singleWords.forEach(w => words.add(w));

        // Two-word phrases
        const twoWords = text.match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g) || [];
        twoWords.forEach(w => words.add(w));

        // Three-word phrases
        const threeWords = text.match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/g) || [];
        threeWords.forEach(w => words.add(w));

        return Array.from(words);
    }

    // Highlight word in text
    function highlightWord(text, word) {
        // Escape special regex characters
        const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b(${escapedWord})\\b`, 'gi');
        
        // Check if already highlighted
        if (text.includes(`[[${word}]]`)) {
            return text;
        }

        return text.replace(regex, (match) => `[[${match}]]`);
    }

    // Process paragraphs
    async function processParagraphs() {
        if (isProcessing) return;
        isProcessing = true;

        const contentDiv = document.getElementById('mw-content-text');
        if (!contentDiv) return;

        // Get all paragraphs
        const paragraphs = contentDiv.querySelectorAll('p');
        
        for (const p of paragraphs) {
            // Skip if already processed
            if (p.dataset.processed) continue;

            let text = p.textContent;
            const candidates = extractCandidateWords(text);

            // Limit candidates to avoid overwhelming API
            const toCheck = candidates.slice(0, CONFIG.maxWordsToCheck);

            for (const word of toCheck) {
                if (word.length < CONFIG.minWordLength) continue;

                // First check our cache
                if (wikiTerms.has(word.toLowerCase())) {
                    text = highlightWord(text, word);
                } else if (!processedWords.has(word.toLowerCase())) {
                    // Check API for new words
                    const exists = await checkWikipediaPage(word);
                    if (exists) {
                        text = highlightWord(text, word);
                    }
                    
                    // Small delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, CONFIG.checkInterval));
                }
            }

            // Update paragraph with highlighted text
            if (text !== p.textContent) {
                // Create highlighted version
                const highlighted = document.createElement('span');
                highlighted.innerHTML = text.replace(/\[\[(.*?)\]\]/g, 
                    '<span style="background-color: ' + CONFIG.highlightColor + 
                    '; padding: 2px 4px; border-radius: 3px; cursor: pointer;" ' +
                    'data-wiki-term="$1">$1</span>');
                
                p.innerHTML = highlighted.innerHTML;
            }

            p.dataset.processed = 'true';
        }

        isProcessing = false;
    }

    // Add click handlers to highlighted words
    function addClickHandlers() {
        document.addEventListener('click', function(e) {
            const term = e.target.dataset.wikiTerm;
            if (term) {
                const url = `/wiki/${encodeURIComponent(term.replace(/ /g, '_'))}`;
                window.location.href = url;
            }
        });
    }

    // Initialize
    async function init() {
        console.log('Wikipedia Article Word Highlighter initialized');
        
        // Extract existing links first
        extractExistingLinks();
        
        // Fetch related terms
        await fetchRelatedTerms();
        
        // Process paragraphs
        await processParagraphs();
        
        // Add click handlers
        addClickHandlers();
        
        console.log('Processing complete');
    }

    // Wait for page to load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
