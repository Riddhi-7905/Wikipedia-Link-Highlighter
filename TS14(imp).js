// ==UserScript==
// @name         Wikipedia Advanced Word Highlighter
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Advanced Wikipedia word highlighter with caching, settings, and smart detection
// @match        https://*.wikipedia.org/wiki/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==

(function() {
    'use strict';

    // Configuration with user settings
    const DEFAULT_CONFIG = {
        enabled: true,
        highlightColor: '#ffeb3b',
        minWordLength: 4,
        maxWordsPerParagraph: 30,
        batchSize: 15,
        delay: 250,
        cacheExpiry: 7 * 24 * 60 * 60 * 1000, // 7 days
        processInViewport: true,
        showProgress: true,
        rateLimit: 100, // requests per minute
        blacklist: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 
                    'August', 'September', 'October', 'November', 'December']
    };

    let CONFIG = { ...DEFAULT_CONFIG };
    let wikiTerms = new Map();
    let cache = { exists: {}, notExists: {}, timestamp: Date.now() };
    let currentArticle = '';
    let isProcessing = false;
    let shouldStop = false;
    let processedCount = 0;
    let totalCount = 0;
    let controlPanel = null;
    let progressBar = null;
    let requestCount = 0;
    let requestTimer = null;

    // Load configuration from storage
    function loadConfig() {
        try {
            const saved = GM_getValue('wikiHighlightConfig');
            if (saved) {
                CONFIG = { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
            }
        } catch (e) {
            console.error('Error loading config:', e);
        }
    }

    // Save configuration
    function saveConfig() {
        try {
            GM_setValue('wikiHighlightConfig', JSON.stringify(CONFIG));
        } catch (e) {
            console.error('Error saving config:', e);
        }
    }

    // Load cache from storage
    function loadCache() {
        try {
            const saved = GM_getValue('wikiHighlightCache');
            if (saved) {
                cache = JSON.parse(saved);
                // Check if cache is expired
                if (Date.now() - cache.timestamp > CONFIG.cacheExpiry) {
                    cache = { exists: {}, notExists: {}, timestamp: Date.now() };
                    saveCache();
                }
            }
        } catch (e) {
            console.error('Error loading cache:', e);
        }
    }

    // Save cache to storage
    function saveCache() {
        try {
            GM_setValue('wikiHighlightCache', JSON.stringify(cache));
        } catch (e) {
            console.error('Error saving cache:', e);
        }
    }

    // Clear old cache entries
    function cleanCache() {
        const newCache = { exists: {}, notExists: {}, timestamp: Date.now() };
        let count = 0;
        
        for (const [term, data] of Object.entries(cache.exists)) {
            if (Date.now() - (data.timestamp || 0) < CONFIG.cacheExpiry) {
                newCache.exists[term] = data;
                count++;
            }
        }
        
        cache = newCache;
        saveCache();
        console.log(`Cache cleaned. ${count} entries kept.`);
    }

    // Rate limiting
    function canMakeRequest() {
        if (!requestTimer) {
            requestTimer = setInterval(() => {
                requestCount = 0;
            }, 60000); // Reset every minute
        }
        
        if (requestCount >= CONFIG.rateLimit) {
            return false;
        }
        requestCount++;
        return true;
    }

    // Get current article title
    function getArticleTitle() {
        const title = document.getElementById('firstHeading');
        if (!title) return '';
        return title.textContent.trim().replace(/\s*\[edit\]\s*$/i, '');
    }

    // Check if word should be excluded
    function shouldExclude(word) {
        const lower = word.toLowerCase();
        
        // Exclude current article
        if (lower === currentArticle.toLowerCase()) return true;
        
        // Exclude blacklisted terms
        if (CONFIG.blacklist.some(b => b.toLowerCase() === lower)) return true;
        
        // Exclude dates and numbers
        if (/^\d+$/.test(word)) return true;
        if (/^\d{1,2}(st|nd|rd|th)$/.test(word)) return true;
        
        // Exclude common words that are unlikely to be articles
        const commonWords = ['this', 'that', 'these', 'those', 'with', 'from', 'have', 'been', 'were', 'their', 'there', 'where', 'what', 'when'];
        if (commonWords.includes(lower)) return true;
        
        return false;
    }

    // Extract existing links
    async function extractExistingLinks() {
        const links = document.querySelectorAll('#mw-content-text a[href^="/wiki/"]:not([href*=":"])');
        
        links.forEach(link => {
            const href = link.getAttribute('href');
            const term = decodeURIComponent(href.replace('/wiki/', '')).replace(/_/g, ' ');
            const lower = term.toLowerCase();
            wikiTerms.set(lower, term);
            cache.exists[lower] = { term, timestamp: Date.now() };
        });
        
        console.log(`Extracted ${wikiTerms.size} existing links`);
    }

    // Fetch related articles
    async function fetchRelatedArticles() {
        try {
            const apiUrl = `${window.location.origin}/w/api.php?action=query&titles=${encodeURIComponent(currentArticle)}&prop=links&format=json&origin=*&pllimit=500`;
            
            if (!canMakeRequest()) {
                console.log('Rate limit reached, skipping API call');
                return;
            }
            
            const response = await fetch(apiUrl);
            const data = await response.json();
            const pages = data.query.pages;
            const pageId = Object.keys(pages)[0];

            if (pageId !== '-1' && pages[pageId].links) {
                pages[pageId].links.forEach(link => {
                    const term = link.title.replace(/_/g, ' ');
                    if (!term.includes(':')) {
                        const lower = term.toLowerCase();
                        wikiTerms.set(lower, term);
                        cache.exists[lower] = { term, timestamp: Date.now() };
                    }
                });
                console.log(`Total terms: ${wikiTerms.size}`);
            }
        } catch (e) {
            console.error('Error fetching related articles:', e);
        }
    }

    // Check if pages exist (with caching)
    async function checkPagesExist(terms) {
        const toCheck = [];
        const cached = [];
        
        terms.forEach(term => {
            const lower = term.toLowerCase();
            
            if (cache.exists[lower]) {
                wikiTerms.set(lower, cache.exists[lower].term);
                cached.push(term);
            } else if (!cache.notExists[lower]) {
                toCheck.push(term);
            }
        });

        if (cached.length > 0) {
            console.log(`Using ${cached.length} cached results`);
        }

        if (toCheck.length === 0) return [];

        if (!canMakeRequest()) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            return checkPagesExist(toCheck);
        }

        const titles = toCheck.join('|');
        const apiUrl = `${window.location.origin}/w/api.php?action=query&titles=${encodeURIComponent(titles)}&format=json&origin=*`;

        try {
            const response = await fetch(apiUrl);
            const data = await response.json();
            const existing = [];

            Object.values(data.query.pages).forEach(page => {
                const lower = page.title.toLowerCase();
                
                if (page.pageid) {
                    wikiTerms.set(lower, page.title);
                    cache.exists[lower] = { term: page.title, timestamp: Date.now() };
                    existing.push(page.title);
                } else {
                    cache.notExists[lower] = Date.now();
                }
            });

            saveCache();
            return existing;
        } catch (e) {
            console.error('Error checking pages:', e);
            return [];
        }
    }

    // Find candidate words
    function findCandidateWords(text) {
        const words = new Set();
        
        // Remove citations and references
        text = text.replace(/\[\d+\]/g, '');
        text = text.replace(/\([^)]*\)/g, '');
        
        // Capitalized words (4+ letters)
        (text.match(/\b[A-Z][a-z]{3,}\b/g) || []).forEach(w => {
            if (!shouldExclude(w)) words.add(w);
        });
        
        // Two-word phrases
        (text.match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g) || []).forEach(w => {
            if (!shouldExclude(w)) words.add(w);
        });
        
        // Three-word phrases
        (text.match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/g) || []).forEach(w => {
            if (!shouldExclude(w)) words.add(w);
        });
        
        // Acronyms
        (text.match(/\b[A-Z]{2,}\b/g) || []).forEach(w => {
            if (!shouldExclude(w) && w.length <= 6) words.add(w);
        });
        
        return Array.from(words);
    }

    // Check if element is in viewport
    function isInViewport(element) {
        const rect = element.getBoundingClientRect();
        return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) + 1000 &&
            rect.right <= (window.innerWidth || document.documentElement.clientWidth)
        );
    }

    // Update progress
    function updateProgress() {
        if (!CONFIG.showProgress || !progressBar) return;
        
        const percent = totalCount > 0 ? Math.round((processedCount / totalCount) * 100) : 0;
        progressBar.style.width = percent + '%';
        progressBar.textContent = `${processedCount}/${totalCount} paragraphs`;
    }

    // Highlight paragraph
    async function highlightParagraph(paragraph) {
        if (shouldStop || paragraph.dataset.highlighted) return;
        
        // Skip if not in viewport and viewport processing is enabled
        if (CONFIG.processInViewport && !isInViewport(paragraph)) {
            return;
        }
        
        // Skip tables, infoboxes, and citation areas
        if (paragraph.closest('.infobox, .navbox, .reflist, table')) {
            paragraph.dataset.highlighted = 'true';
            return;
        }
        
        const text = paragraph.textContent;
        const candidates = findCandidateWords(text);
        
        const toCheck = candidates.filter(word => {
            const lower = word.toLowerCase();
            return lower.length >= CONFIG.minWordLength &&
                   !wikiTerms.has(lower) &&
                   !shouldExclude(word);
        }).slice(0, CONFIG.maxWordsPerParagraph);

        // Check in batches
        for (let i = 0; i < toCheck.length; i += CONFIG.batchSize) {
            if (shouldStop) break;
            
            const batch = toCheck.slice(i, i + CONFIG.batchSize);
            await checkPagesExist(batch);
            
            if (i + CONFIG.batchSize < toCheck.length) {
                await new Promise(r => setTimeout(r, CONFIG.delay));
            }
        }

        if (!shouldStop) {
            highlightInParagraph(paragraph);
        }
        
        paragraph.dataset.highlighted = 'true';
        processedCount++;
        updateProgress();
    }

    // Apply highlighting
    function highlightInParagraph(paragraph) {
        const walker = document.createTreeWalker(
            paragraph,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function(node) {
                    if (node.parentElement.tagName === 'A' || 
                        node.parentElement.closest('[data-wiki-highlight]')) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        const textNodes = [];
        let node;
        while (node = walker.nextNode()) {
            textNodes.push(node);
        }

        textNodes.forEach(textNode => {
            highlightTextNode(textNode);
        });
    }

    // Highlight text node
    function highlightTextNode(textNode) {
        const text = textNode.textContent;
        const matches = [];

        wikiTerms.forEach((originalTerm, lowerTerm) => {
            if (shouldExclude(originalTerm)) return;
            
            const regex = new RegExp(`\\b(${originalTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
            let match;
            
            while ((match = regex.exec(text)) !== null) {
                matches.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    text: match[0]
                });
            }
        });

        if (matches.length === 0) return;

        matches.sort((a, b) => a.start - b.start);
        const validMatches = [];
        
        for (const match of matches) {
            const overlaps = validMatches.some(m => 
                (match.start >= m.start && match.start < m.end) ||
                (match.end > m.start && match.end <= m.end)
            );
            if (!overlaps) {
                validMatches.push(match);
            }
        }

        if (validMatches.length === 0) return;

        let newHTML = '';
        let lastIndex = 0;

        validMatches.forEach(match => {
            newHTML += text.substring(lastIndex, match.start);
            newHTML += `<span data-wiki-highlight style="background-color: ${CONFIG.highlightColor}; padding: 2px 4px; border-radius: 3px; cursor: pointer; transition: background-color 0.2s;" data-term="${match.text}" onmouseover="this.style.backgroundColor='#ffd700'" onmouseout="this.style.backgroundColor='${CONFIG.highlightColor}'">${match.text}</span>`;
            lastIndex = match.end;
        });
        newHTML += text.substring(lastIndex);

        const wrapper = document.createElement('span');
        wrapper.innerHTML = newHTML;
        textNode.parentNode.replaceChild(wrapper, textNode);
    }

    // Process all paragraphs
    async function processAllParagraphs() {
        if (isProcessing) return;
        isProcessing = true;
        shouldStop = false;
        processedCount = 0;

        const paragraphs = document.querySelectorAll('#mw-content-text p');
        const validParagraphs = Array.from(paragraphs).filter(p => 
            p.textContent.trim().length > 50 && 
            !p.dataset.highlighted
        );

        totalCount = validParagraphs.length;
        console.log(`Processing ${totalCount} paragraphs...`);
        
        if (CONFIG.showProgress) {
            showProgress();
        }

        // Process viewport first
        const inViewport = validParagraphs.filter(p => isInViewport(p));
        const notInViewport = validParagraphs.filter(p => !isInViewport(p));

        for (const p of inViewport) {
            if (shouldStop) break;
            await highlightParagraph(p);
        }

        for (const p of notInViewport) {
            if (shouldStop) break;
            await highlightParagraph(p);
        }

        isProcessing = false;
        console.log('Highlighting complete!');
        
        if (CONFIG.showProgress && progressBar) {
            setTimeout(() => {
                progressBar.parentElement.style.display = 'none';
            }, 2000);
        }
    }

    // Show progress bar
    function showProgress() {
        let container = document.getElementById('wiki-highlight-progress');
        
        if (!container) {
            container = document.createElement('div');
            container.id = 'wiki-highlight-progress';
            container.style.cssText = `
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: 250px;
                background: white;
                border: 2px solid #0645ad;
                border-radius: 8px;
                padding: 10px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                z-index: 10000;
                font-family: sans-serif;
            `;
            
            const label = document.createElement('div');
            label.textContent = 'Processing...';
            label.style.cssText = 'font-size: 12px; margin-bottom: 5px; color: #333;';
            
            const barContainer = document.createElement('div');
            barContainer.style.cssText = 'width: 100%; height: 20px; background: #f0f0f0; border-radius: 4px; overflow: hidden;';
            
            progressBar = document.createElement('div');
            progressBar.style.cssText = `
                height: 100%;
                background: #0645ad;
                width: 0%;
                transition: width 0.3s;
                display: flex;
                align-items: center;
                justify-content: center;
                color: white;
                font-size: 11px;
                font-weight: bold;
            `;
            
            barContainer.appendChild(progressBar);
            container.appendChild(label);
            container.appendChild(barContainer);
            document.body.appendChild(container);
        }
        
        container.style.display = 'block';
        updateProgress();
    }

    // Create control panel
    function createControlPanel() {
        const panel = document.createElement('div');
        panel.id = 'wiki-highlight-controls';
        panel.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            width: 280px;
            background: white;
            border: 2px solid #0645ad;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            z-index: 9999;
            font-family: sans-serif;
            display: none;
        `;

        panel.innerHTML = `
            <div style="background: #0645ad; color: white; padding: 10px 15px; font-weight: bold; border-radius: 6px 6px 0 0; display: flex; justify-content: space-between; align-items: center;">
                <span>⚙️ Highlighter Settings</span>
                <button id="closePanel" style="background: none; border: none; color: white; cursor: pointer; font-size: 20px; padding: 0;">×</button>
            </div>
            <div style="padding: 15px;">
                <label style="display: flex; align-items: center; margin-bottom: 12px; cursor: pointer;">
                    <input type="checkbox" id="enableHighlight" ${CONFIG.enabled ? 'checked' : ''} style="margin-right: 8px;">
                    <span style="font-size: 13px;">Enable highlighting</span>
                </label>
                
                <label style="display: block; margin-bottom: 8px; font-size: 13px;">
                    Highlight color:
                    <input type="color" id="highlightColor" value="${CONFIG.highlightColor}" style="margin-left: 8px; cursor: pointer;">
                </label>
                
                <label style="display: block; margin-bottom: 8px; font-size: 13px;">
                    Min word length: ${CONFIG.minWordLength}
                    <input type="range" id="minWordLength" min="3" max="8" value="${CONFIG.minWordLength}" style="width: 100%; cursor: pointer;">
                </label>
                
                <label style="display: flex; align-items: center; margin-bottom: 12px; cursor: pointer;">
                    <input type="checkbox" id="showProgress" ${CONFIG.showProgress ? 'checked' : ''} style="margin-right: 8px;">
                    <span style="font-size: 13px;">Show progress bar</span>
                </label>
                
                <div style="margin-top: 15px; display: flex; gap: 8px;">
                    <button id="refreshHighlight" style="flex: 1; padding: 8px; background: #0645ad; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
                        🔄 Refresh
                    </button>
                    <button id="clearCache" style="flex: 1; padding: 8px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
                        🗑️ Clear Cache
                    </button>
                </div>
                
                <div style="margin-top: 12px; padding: 10px; background: #f8f9fa; border-radius: 4px; font-size: 11px; color: #666;">
                    <div>Cached terms: ${Object.keys(cache.exists).length}</div>
                    <div>Active: ${wikiTerms.size} terms</div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        // Event listeners
        document.getElementById('closePanel').addEventListener('click', () => {
            panel.style.display = 'none';
        });

        document.getElementById('enableHighlight').addEventListener('change', (e) => {
            CONFIG.enabled = e.target.checked;
            saveConfig();
            if (CONFIG.enabled) {
                location.reload();
            }
        });

        document.getElementById('highlightColor').addEventListener('change', (e) => {
            CONFIG.highlightColor = e.target.value;
            saveConfig();
            document.querySelectorAll('[data-wiki-highlight]').forEach(el => {
                el.style.backgroundColor = CONFIG.highlightColor;
            });
        });

        document.getElementById('minWordLength').addEventListener('input', (e) => {
            CONFIG.minWordLength = parseInt(e.target.value);
            e.target.previousElementSibling.textContent = `Min word length: ${CONFIG.minWordLength}`;
            saveConfig();
        });

        document.getElementById('showProgress').addEventListener('change', (e) => {
            CONFIG.showProgress = e.target.checked;
            saveConfig();
        });

        document.getElementById('refreshHighlight').addEventListener('click', () => {
            location.reload();
        });

        document.getElementById('clearCache').addEventListener('click', () => {
            if (confirm('Clear all cached data? This will require re-checking all terms.')) {
                cache = { exists: {}, notExists: {}, timestamp: Date.now() };
                saveCache();
                alert('Cache cleared! The page will reload.');
                location.reload();
            }
        });

        return panel;
    }

    // Add floating toggle button
    function addToggleButton() {
        const btn = document.createElement('button');
        btn.id = 'wiki-highlight-toggle';
        btn.innerHTML = '⚙️';
        btn.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            width: 50px;
            height: 50px;
            background: #0645ad;
            color: white;
            border: none;
            border-radius: 50%;
            cursor: pointer;
            font-size: 20px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 9998;
            transition: transform 0.2s;
        `;
        
        btn.addEventListener('mouseenter', () => {
            btn.style.transform = 'scale(1.1)';
        });
        
        btn.addEventListener('mouseleave', () => {
            btn.style.transform = 'scale(1)';
        });
        
        btn.addEventListener('click', () => {
            if (controlPanel.style.display === 'none') {
                controlPanel.style.display = 'block';
                btn.style.display = 'none';
            }
        });
        
        document.body.appendChild(btn);
        
        // Show button when panel is closed
        document.getElementById('closePanel').addEventListener('click', () => {
            btn.style.display = 'block';
        });
    }

    // Handle clicks
    document.addEventListener('click', (e) => {
        const term = e.target.dataset.term;
        if (term && e.target.dataset.wikiHighlight !== undefined) {
            const url = `${window.location.origin}/wiki/${encodeURIComponent(term.replace(/ /g, '_'))}`;
            if (e.ctrlKey || e.metaKey) {
                window.open(url, '_blank');
            } else {
                window.location.href = url;
            }
        }
    });

    // Handle page unload
    window.addEventListener('beforeunload', () => {
        shouldStop = true;
        saveCache();
    });

    // Initialize
    async function init() {
        if (!CONFIG.enabled) {
            console.log('Wikipedia Highlighter is disabled');
            return;
        }

        currentArticle = getArticleTitle();
        console.log('Wikipedia Advanced Highlighter v4.0');
        console.log(`Article: "${currentArticle}"`);

        loadConfig();
        loadCache();
        
        controlPanel = createControlPanel();
        addToggleButton();

        await extractExistingLinks();
        await fetchRelatedArticles();
        await processAllParagraphs();
        
        // Clean cache periodically
        cleanCache();
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
