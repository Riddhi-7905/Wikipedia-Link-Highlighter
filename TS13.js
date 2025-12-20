// ==UserScript==
// @name         Wikipedia Editor Link Helper
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Help Wikipedia editors by suggesting words that could be linked to existing articles
// @match        https://*.wikipedia.org/wiki/*
// @grant        GM_xmlhttpRequest
// @connect      *.wikipedia.org
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        panelWidth: '320px',
        checkInterval: 300,
        batchSize: 15
    };

    let wikiTerms = new Set();
    let currentArticleTitle = '';
    let suggestionPanel = null;

    // Get current article title
    function getArticleTitle() {
        const title = document.getElementById('firstHeading');
        return title ? title.textContent.trim().replace(/\s*\[edit\]\s*$/i, '') : '';
    }

    // Check if we're in edit mode
    function isEditMode() {
        return document.getElementById('wpTextbox1') !== null || 
               document.querySelector('.ve-ce-surface') !== null;
    }

    // Fetch links from current article's page
    async function fetchArticleLinks() {
        try {
            const apiUrl = `${window.location.origin}/w/api.php?action=query&titles=${encodeURIComponent(currentArticleTitle)}&prop=links&format=json&origin=*&pllimit=500`;
            
            const response = await fetch(apiUrl);
            const data = await response.json();
            const pages = data.query.pages;
            const pageId = Object.keys(pages)[0];

            if (pageId !== '-1' && pages[pageId].links) {
                pages[pageId].links.forEach(link => {
                    const term = link.title.replace(/_/g, ' ');
                    if (!term.includes(':')) {
                        wikiTerms.add(term.toLowerCase());
                    }
                });
            }
        } catch (e) {
            console.error('Error fetching links:', e);
        }
    }

    // Extract existing wikilinks from the text
    function extractExistingLinks(text) {
        const existing = new Set();
        const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
        let match;
        
        while ((match = linkRegex.exec(text)) !== null) {
            existing.add(match[1].toLowerCase());
        }
        
        return existing;
    }

    // Check if Wikipedia pages exist (batch)
    async function checkWikipediaPages(terms) {
        if (terms.length === 0) return new Set();

        const titles = terms.join('|');
        const apiUrl = `${window.location.origin}/w/api.php?action=query&titles=${encodeURIComponent(titles)}&format=json&origin=*`;

        try {
            const response = await fetch(apiUrl);
            const data = await response.json();
            const existing = new Set();

            Object.values(data.query.pages).forEach(page => {
                if (page.pageid) {
                    existing.add(page.title.toLowerCase());
                    wikiTerms.add(page.title.toLowerCase());
                }
            });

            return existing;
        } catch (e) {
            console.error('Error checking pages:', e);
            return new Set();
        }
    }

    // Extract potential linkable words from text
    function findLinkableWords(text) {
        const candidates = [];
        
        // Remove existing wikilinks to avoid suggesting already linked terms
        const cleanText = text.replace(/\[\[.*?\]\]/g, '');
        
        // Find capitalized words and phrases
        const patterns = [
            /\b([A-Z][a-z]{3,}(?:\s+[A-Z][a-z]+){0,2})\b/g,  // Capitalized phrases (1-3 words)
            /\b([A-Z]{2,})\b/g  // Acronyms
        ];

        patterns.forEach(pattern => {
            let match;
            while ((match = pattern.exec(cleanText)) !== null) {
                candidates.push({
                    word: match[1],
                    position: match.index
                });
            }
        });

        return candidates;
    }

    // Create suggestion panel
    function createSuggestionPanel() {
        const panel = document.createElement('div');
        panel.id = 'wiki-link-suggestions';
        panel.style.cssText = `
            position: fixed;
            right: 20px;
            top: 100px;
            width: ${CONFIG.panelWidth};
            max-height: 70vh;
            background: white;
            border: 2px solid #0645ad;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 10000;
            overflow: hidden;
            font-family: sans-serif;
            display: flex;
            flex-direction: column;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            background: #0645ad;
            color: white;
            padding: 12px 15px;
            font-weight: bold;
            font-size: 14px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        header.innerHTML = `
            <span>📝 Link Suggestions</span>
            <button id="closeSuggestions" style="background: none; border: none; color: white; cursor: pointer; font-size: 18px; padding: 0; width: 24px; height: 24px;">×</button>
        `;

        const content = document.createElement('div');
        content.id = 'suggestion-content';
        content.style.cssText = `
            padding: 15px;
            overflow-y: auto;
            flex: 1;
            font-size: 13px;
        `;
        content.innerHTML = '<div style="color: #666;">Analyzing article text...</div>';

        const footer = document.createElement('div');
        footer.style.cssText = `
            padding: 10px 15px;
            background: #f8f9fa;
            border-top: 1px solid #ddd;
            font-size: 11px;
            color: #666;
        `;
        footer.innerHTML = 'Click a suggestion to copy wikilink format';

        panel.appendChild(header);
        panel.appendChild(content);
        panel.appendChild(footer);
        document.body.appendChild(panel);

        // Close button handler
        document.getElementById('closeSuggestions').addEventListener('click', () => {
            panel.style.display = 'none';
        });

        return panel;
    }

    // Update suggestion panel with results
    function updateSuggestions(suggestions) {
        const content = document.getElementById('suggestion-content');
        
        if (suggestions.length === 0) {
            content.innerHTML = '<div style="color: #666;">No new link suggestions found.</div>';
            return;
        }

        let html = '<div style="margin-bottom: 10px; color: #333; font-weight: bold;">Suggested Links:</div>';
        
        suggestions.forEach(item => {
            html += `
                <div class="suggestion-item" data-term="${item.word}" style="
                    padding: 8px 10px;
                    margin: 5px 0;
                    background: #f0f8ff;
                    border-left: 3px solid #0645ad;
                    cursor: pointer;
                    border-radius: 3px;
                    transition: background 0.2s;
                ">
                    <div style="font-weight: 500; color: #0645ad;">${item.word}</div>
                    <div style="font-size: 11px; color: #666; margin-top: 3px;">
                        Click to copy: [[${item.word}]]
                    </div>
                </div>
            `;
        });

        content.innerHTML = html;

        // Add click handlers
        document.querySelectorAll('.suggestion-item').forEach(item => {
            item.addEventListener('mouseenter', function() {
                this.style.background = '#e6f2ff';
            });
            item.addEventListener('mouseleave', function() {
                this.style.background = '#f0f8ff';
            });
            item.addEventListener('click', function() {
                const term = this.dataset.term;
                const wikilink = `[[${term}]]`;
                
                // Copy to clipboard
                navigator.clipboard.writeText(wikilink).then(() => {
                    const originalHTML = this.innerHTML;
                    this.innerHTML = '<div style="color: #28a745; font-weight: bold;">✓ Copied to clipboard!</div>';
                    this.style.background = '#d4edda';
                    
                    setTimeout(() => {
                        this.innerHTML = originalHTML;
                        this.style.background = '#f0f8ff';
                    }, 1500);
                });
            });
        });
    }

    // Analyze the article text
    async function analyzeText() {
        const textarea = document.getElementById('wpTextbox1');
        if (!textarea) return;

        const text = textarea.value;
        const existingLinks = extractExistingLinks(text);
        
        // Find potential linkable words
        const candidates = findLinkableWords(text);
        
        // Remove duplicates and already linked terms
        const uniqueCandidates = [];
        const seen = new Set();
        
        candidates.forEach(item => {
            const lower = item.word.toLowerCase();
            if (!seen.has(lower) && 
                !existingLinks.has(lower) && 
                lower !== currentArticleTitle.toLowerCase()) {
                seen.add(lower);
                uniqueCandidates.push(item);
            }
        });

        // Check which ones have Wikipedia articles
        const suggestions = [];
        const batchSize = CONFIG.batchSize;
        
        for (let i = 0; i < uniqueCandidates.length; i += batchSize) {
            const batch = uniqueCandidates.slice(i, i + batchSize);
            const batchTerms = batch.map(b => b.word);
            
            const existing = await checkWikipediaPages(batchTerms);
            
            batch.forEach(item => {
                if (existing.has(item.word.toLowerCase())) {
                    suggestions.push(item);
                }
            });
            
            if (i + batchSize < uniqueCandidates.length) {
                await new Promise(resolve => setTimeout(resolve, CONFIG.checkInterval));
            }
        }

        // Sort by position in text
        suggestions.sort((a, b) => a.position - b.position);
        
        updateSuggestions(suggestions);
    }

    // Add "Analyze Links" button to edit toolbar
    function addAnalyzeButton() {
        const toolbar = document.getElementById('wikiEditor-ui-toolbar') || 
                       document.querySelector('.wikiEditor-ui-toolbar') ||
                       document.querySelector('#toolbar');
        
        if (!toolbar) {
            // Fallback: add button near save button
            const editButtons = document.querySelector('.editButtons');
            if (editButtons) {
                const btn = document.createElement('button');
                btn.textContent = '🔗 Find Link Suggestions';
                btn.type = 'button';
                btn.style.cssText = `
                    margin-left: 10px;
                    padding: 6px 12px;
                    background: #0645ad;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 13px;
                `;
                btn.addEventListener('click', () => {
                    if (suggestionPanel) {
                        suggestionPanel.style.display = 'flex';
                    }
                    analyzeText();
                });
                editButtons.insertBefore(btn, editButtons.firstChild);
            }
            return;
        }

        const btn = document.createElement('button');
        btn.textContent = '🔗 Find Links';
        btn.type = 'button';
        btn.style.cssText = `
            padding: 4px 10px;
            margin: 2px;
            background: #0645ad;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
        `;
        btn.addEventListener('click', () => {
            if (suggestionPanel) {
                suggestionPanel.style.display = 'flex';
            }
            analyzeText();
        });
        toolbar.appendChild(btn);
    }

    // Initialize
    async function init() {
        if (!isEditMode()) {
            console.log('Wikipedia Editor Link Helper: Not in edit mode');
            return;
        }

        currentArticleTitle = getArticleTitle();
        console.log('Wikipedia Editor Link Helper initialized');
        console.log(`Article: ${currentArticleTitle}`);

        // Fetch related terms
        await fetchArticleLinks();
        
        // Create suggestion panel
        suggestionPanel = createSuggestionPanel();
        suggestionPanel.style.display = 'none';

        // Add analyze button
        setTimeout(addAnalyzeButton, 1000);
    }

    // Start when page loads
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
