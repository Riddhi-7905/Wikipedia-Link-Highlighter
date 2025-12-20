// ==UserScript==
// @name         Wikipedia Smart Editor Assistant
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Intelligent Wikipedia editor tool - finds relevant linkable terms with Wikidata support
// @match        https://*.wikipedia.org/wiki/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      *.wikipedia.org
// @connect      *.wikidata.org
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        enabled: true,
        highlightColor: 'rgba(255, 235, 59, 0.3)', // Semi-transparent
        borderColor: '#ffc107',
        minRelevanceScore: 0.3,
        batchSize: 20,
        delay: 200,
        cacheExpiry: 7 * 24 * 60 * 60 * 1000,
        showCount: true
    };

    let relevantTerms = new Map(); // term -> {score, count, positions}
    let cache = {};
    let currentArticle = '';
    let qid = null; // Wikidata QID
    let isEditMode = false;
    let highlightsEnabled = true;
    let processedParagraphs = new Set();
    let wordOccurrences = new Map(); // term -> {count, positions: [{para, offset}]}
    let sidePanel = null;

    // ==================== UTILITY FUNCTIONS ====================

    function getArticleTitle() {
        const title = document.getElementById('firstHeading');
        if (!title) return '';
        return title.textContent.trim().replace(/\s*\[edit\]\s*$/i, '');
    }

    function checkEditMode() {
        return document.getElementById('wpTextbox1') !== null ||
               document.querySelector('.ve-ce-surface') !== null ||
               window.location.search.includes('action=edit');
    }

    function loadCache() {
        try {
            const saved = GM_getValue('wikiEditorCache_v2');
            if (saved) {
                cache = JSON.parse(saved);
                if (Date.now() - (cache.timestamp || 0) > CONFIG.cacheExpiry) {
                    cache = {};
                }
            }
        } catch (e) {
            console.error('Cache load error:', e);
        }
    }

    function saveCache() {
        try {
            cache.timestamp = Date.now();
            GM_setValue('wikiEditorCache_v2', JSON.stringify(cache));
        } catch (e) {
            console.error('Cache save error:', e);
        }
    }

    // ==================== WIKIDATA INTEGRATION ====================

    async function getWikidataQID() {
        try {
            const apiUrl = `${window.location.origin}/w/api.php?action=query&titles=${encodeURIComponent(currentArticle)}&prop=pageprops&format=json&origin=*`;
            const response = await fetch(apiUrl);
            const data = await response.json();
            const pages = data.query.pages;
            const pageId = Object.keys(pages)[0];
            
            if (pageId !== '-1' && pages[pageId].pageprops) {
                return pages[pageId].pageprops.wikibase_item || null;
            }
        } catch (e) {
            console.error('Error fetching Wikidata QID:', e);
        }
        return null;
    }

    async function fetchWikidataRelatedEntities() {
        if (!qid) return [];

        const cacheKey = `wikidata_${qid}`;
        if (cache[cacheKey]) {
            console.log('Using cached Wikidata entities');
            return cache[cacheKey];
        }

        try {
            // SPARQL query to get related entities
            const query = `
                SELECT DISTINCT ?item ?itemLabel WHERE {
                  {
                    wd:${qid} ?p ?item .
                    ?item wikibase:sitelinks ?sitelinks .
                    FILTER(?sitelinks > 5)
                  } UNION {
                    ?item ?p wd:${qid} .
                    ?item wikibase:sitelinks ?sitelinks .
                    FILTER(?sitelinks > 5)
                  }
                  FILTER(STRSTARTS(STR(?item), "http://www.wikidata.org/entity/Q"))
                  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
                }
                LIMIT 100
            `;

            const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`;
            
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    headers: {
                        'Accept': 'application/json'
                    },
                    onload: function(response) {
                        try {
                            const data = JSON.parse(response.responseText);
                            const entities = data.results.bindings.map(b => b.itemLabel.value);
                            cache[cacheKey] = entities;
                            saveCache();
                            console.log(`Fetched ${entities.length} related entities from Wikidata`);
                            resolve(entities);
                        } catch (e) {
                            console.error('Wikidata parse error:', e);
                            resolve([]);
                        }
                    },
                    onerror: function() {
                        resolve([]);
                    },
                    timeout: 10000
                });
            });
        } catch (e) {
            console.error('Wikidata query error:', e);
            return [];
        }
    }

    // ==================== RELEVANCE SCORING ====================

    function calculateRelevance(term, articleLinks, wikidataEntities) {
        let score = 0;
        const lower = term.toLowerCase();
        const articleLower = currentArticle.toLowerCase();

        // Exclude exact article title
        if (lower === articleLower) return 0;
        if (articleLower.includes(lower) || lower.includes(articleLower)) return 0;

        // High score: in article's outgoing links
        if (articleLinks.has(lower)) score += 0.5;

        // High score: in Wikidata related entities
        if (wikidataEntities.some(e => e.toLowerCase() === lower)) score += 0.4;

        // Medium score: capitalized (likely proper noun)
        if (/^[A-Z]/.test(term)) score += 0.2;

        // Penalty for common words unlikely to be relevant
        const commonWords = ['the', 'and', 'or', 'but', 'with', 'from', 'this', 'that', 'these', 'those', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        if (commonWords.includes(lower)) score -= 1;

        // Penalty for numbers and dates
        if (/^\d+$/.test(term)) score -= 1;

        return Math.max(0, Math.min(1, score));
    }

    // ==================== FETCH ARTICLE DATA ====================

    async function fetchArticleLinks() {
        const links = new Set();
        
        try {
            const apiUrl = `${window.location.origin}/w/api.php?action=query&titles=${encodeURIComponent(currentArticle)}&prop=links&format=json&origin=*&pllimit=500`;
            const response = await fetch(apiUrl);
            const data = await response.json();
            const pages = data.query.pages;
            const pageId = Object.keys(pages)[0];

            if (pageId !== '-1' && pages[pageId].links) {
                pages[pageId].links.forEach(link => {
                    const term = link.title.replace(/_/g, ' ');
                    if (!term.includes(':')) {
                        links.add(term.toLowerCase());
                    }
                });
            }
        } catch (e) {
            console.error('Error fetching article links:', e);
        }

        return links;
    }

    async function checkTermsExist(terms) {
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
                }
            });

            return existing;
        } catch (e) {
            console.error('Error checking terms:', e);
            return new Set();
        }
    }

    // ==================== WORD DETECTION ====================

    function extractWords(text) {
        const words = new Set();
        
        // Remove existing wikilinks
        text = text.replace(/\[\[.*?\]\]/g, '');
        
        // Single capitalized words (4+ chars)
        (text.match(/\b[A-Z][a-z]{3,}\b/g) || []).forEach(w => words.add(w));
        
        // Two-word phrases
        (text.match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g) || []).forEach(w => words.add(w));
        
        // Three-word phrases
        (text.match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/g) || []).forEach(w => words.add(w));
        
        return Array.from(words);
    }

    function trackWordOccurrences(text, paragraphIndex) {
        const words = extractWords(text);
        
        words.forEach(word => {
            const lower = word.toLowerCase();
            const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
            let match;
            
            while ((match = regex.exec(text)) !== null) {
                if (!wordOccurrences.has(lower)) {
                    wordOccurrences.set(lower, { count: 0, positions: [] });
                }
                const data = wordOccurrences.get(lower);
                data.count++;
                data.positions.push({ para: paragraphIndex, offset: match.index });
                wordOccurrences.set(lower, data);
            }
        });
    }

    // ==================== PROCESSING ====================

    async function analyzeAndBuildTermList() {
        console.log('🔍 Analyzing article for relevant terms...');
        
        updateStatus('Fetching article links...');
        const articleLinks = await fetchArticleLinks();
        
        updateStatus('Querying Wikidata...');
        qid = await getWikidataQID();
        const wikidataEntities = qid ? await fetchWikidataRelatedEntities() : [];
        
        updateStatus('Analyzing text...');
        
        // Get all text from article or textarea
        let allText = '';
        const paragraphs = isEditMode 
            ? [document.getElementById('wpTextbox1')]
            : Array.from(document.querySelectorAll('#mw-content-text p'));
        
        paragraphs.forEach((p, idx) => {
            if (p) {
                const text = isEditMode ? p.value : p.textContent;
                allText += text + '\n';
                trackWordOccurrences(text, idx);
            }
        });

        const allWords = extractWords(allText);
        console.log(`Found ${allWords.length} candidate words`);

        updateStatus('Checking Wikipedia...');
        
        // Check existence in batches
        const batches = [];
        for (let i = 0; i < allWords.length; i += CONFIG.batchSize) {
            batches.push(allWords.slice(i, i + CONFIG.batchSize));
        }

        const existingTerms = new Set();
        for (const batch of batches) {
            const existing = await checkTermsExist(batch);
            existing.forEach(t => existingTerms.add(t));
            await new Promise(r => setTimeout(r, CONFIG.delay));
        }

        // Calculate relevance scores
        updateStatus('Calculating relevance...');
        
        existingTerms.forEach(term => {
            const score = calculateRelevance(term, articleLinks, wikidataEntities);
            if (score >= CONFIG.minRelevanceScore) {
                const occurrences = wordOccurrences.get(term);
                relevantTerms.set(term, {
                    score: score,
                    count: occurrences ? occurrences.count : 1,
                    positions: occurrences ? occurrences.positions : []
                });
            }
        });

        console.log(`✅ Found ${relevantTerms.size} relevant linkable terms`);
        updateSidePanel();
    }

    // ==================== HIGHLIGHTING ====================

    function highlightInElement(element) {
        if (!highlightsEnabled) return;
        if (element.dataset.highlighted) return;

        const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    if (node.parentElement.tagName === 'A' || 
                        node.parentElement.closest('[data-hl]')) {
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
            const text = textNode.textContent;
            const matches = [];

            relevantTerms.forEach((data, term) => {
                const regex = new RegExp(`\\b(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
                let match;
                
                while ((match = regex.exec(text)) !== null) {
                    matches.push({
                        start: match.index,
                        end: match.index + match[0].length,
                        text: match[0],
                        term: term
                    });
                }
            });

            if (matches.length === 0) return;

            matches.sort((a, b) => a.start - b.start);
            const validMatches = [];
            
            for (const m of matches) {
                const overlaps = validMatches.some(v => 
                    (m.start >= v.start && m.start < v.end) ||
                    (m.end > v.start && m.end <= v.end)
                );
                if (!overlaps) validMatches.push(m);
            }

            if (validMatches.length === 0) return;

            let html = '';
            let lastIdx = 0;

            validMatches.forEach(m => {
                html += text.substring(lastIdx, m.start);
                const termData = relevantTerms.get(m.term.toLowerCase());
                const countBadge = CONFIG.showCount && termData ? `<sup style="font-size: 9px; color: #666;">${termData.count}</sup>` : '';
                html += `<span data-hl data-term="${m.text}" style="background: ${CONFIG.highlightColor}; border-bottom: 2px solid ${CONFIG.borderColor}; cursor: pointer; position: relative; padding: 1px 3px; border-radius: 2px;" title="Click to add [[brackets]] or navigate">${m.text}${countBadge}</span>`;
                lastIdx = m.end;
            });
            html += text.substring(lastIdx);

            const wrapper = document.createElement('span');
            wrapper.innerHTML = html;
            textNode.parentNode.replaceChild(wrapper, textNode);
        });

        element.dataset.highlighted = 'true';
    }

    function applyHighlights() {
        if (isEditMode) return; // Don't highlight in edit textarea, use side panel instead
        
        const paragraphs = document.querySelectorAll('#mw-content-text p');
        paragraphs.forEach(p => {
            if (!p.dataset.highlighted && p.textContent.trim().length > 50) {
                highlightInElement(p);
            }
        });
    }

    // ==================== UI COMPONENTS ====================

    function updateStatus(message) {
        const status = document.getElementById('wiki-status');
        if (status) {
            status.textContent = message;
        }
    }

    function createSidePanel() {
        const panel = document.createElement('div');
        panel.id = 'wiki-side-panel';
        panel.style.cssText = `
            position: fixed;
            right: 0;
            top: 100px;
            width: 320px;
            max-height: calc(100vh - 120px);
            background: white;
            border: 2px solid #0645ad;
            border-right: none;
            border-radius: 8px 0 0 8px;
            box-shadow: -4px 4px 12px rgba(0,0,0,0.2);
            z-index: 10000;
            font-family: sans-serif;
            display: flex;
            flex-direction: column;
            transform: translateX(${isEditMode ? '0' : '320px'});
            transition: transform 0.3s ease;
        `;

        panel.innerHTML = `
            <div style="background: linear-gradient(135deg, #0645ad 0%, #0066cc 100%); color: white; padding: 12px 15px; font-weight: bold; border-radius: 6px 0 0 0; display: flex; justify-content: space-between; align-items: center;">
                <span>🔗 Linkable Terms</span>
                <div>
                    <button id="toggleHighlights" style="background: rgba(255,255,255,0.2); border: 1px solid white; color: white; cursor: pointer; padding: 4px 8px; border-radius: 3px; margin-right: 5px; font-size: 11px;">
                        ${highlightsEnabled ? '👁️ ON' : '👁️ OFF'}
                    </button>
                    <button id="refreshTerms" style="background: rgba(255,255,255,0.2); border: 1px solid white; color: white; cursor: pointer; padding: 4px 8px; border-radius: 3px; margin-right: 5px; font-size: 11px;">
                        🔄
                    </button>
                    <button id="togglePanel" style="background: none; border: none; color: white; cursor: pointer; font-size: 18px; padding: 0;">‹</button>
                </div>
            </div>
            <div id="wiki-status" style="padding: 8px 15px; background: #f8f9fa; border-bottom: 1px solid #ddd; font-size: 11px; color: #666;">
                Ready
            </div>
            <div id="term-list" style="flex: 1; overflow-y: auto; padding: 10px;">
                <div style="text-align: center; color: #999; padding: 20px;">Click "🔄" to analyze</div>
            </div>
        `;

        document.body.appendChild(panel);

        // Toggle panel
        document.getElementById('togglePanel').addEventListener('click', () => {
            const isOpen = panel.style.transform === 'translateX(0px)';
            panel.style.transform = isOpen ? 'translateX(320px)' : 'translateX(0px)';
            document.getElementById('togglePanel').textContent = isOpen ? '›' : '‹';
        });

        // Toggle highlights
        document.getElementById('toggleHighlights').addEventListener('click', () => {
            highlightsEnabled = !highlightsEnabled;
            document.getElementById('toggleHighlights').textContent = highlightsEnabled ? '👁️ ON' : '👁️ OFF';
            
            if (highlightsEnabled) {
                applyHighlights();
            } else {
                document.querySelectorAll('[data-hl]').forEach(el => {
                    el.replaceWith(el.textContent);
                });
            }
        });

        // Refresh
        document.getElementById('refreshTerms').addEventListener('click', async () => {
            relevantTerms.clear();
            wordOccurrences.clear();
            await analyzeAndBuildTermList();
            if (highlightsEnabled) {
                applyHighlights();
            }
        });

        return panel;
    }

    function updateSidePanel() {
        const list = document.getElementById('term-list');
        if (!list) return;

        if (relevantTerms.size === 0) {
            list.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">No relevant terms found</div>';
            return;
        }

        // Sort by relevance score
        const sorted = Array.from(relevantTerms.entries())
            .sort((a, b) => b[1].score - a[1].score);

        let html = '';
        sorted.forEach(([term, data]) => {
            const scorePercent = Math.round(data.score * 100);
            html += `
                <div class="term-item" data-term="${term}" style="
                    margin: 8px 0;
                    padding: 10px;
                    background: #f8f9fa;
                    border-left: 3px solid ${scorePercent > 70 ? '#28a745' : scorePercent > 40 ? '#ffc107' : '#6c757d'};
                    border-radius: 4px;
                    cursor: pointer;
                    transition: all 0.2s;
                " onmouseover="this.style.background='#e9ecef'" onmouseout="this.style.background='#f8f9fa'">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <strong style="color: #0645ad; font-size: 13px;">${term}</strong>
                        <span style="font-size: 10px; background: rgba(6,69,173,0.1); padding: 2px 6px; border-radius: 3px; color: #0645ad;">
                            ${data.count}x
                        </span>
                    </div>
                    <div style="font-size: 10px; color: #666; margin-top: 4px;">
                        Relevance: ${scorePercent}%
                    </div>
                </div>
            `;
        });

        list.innerHTML = html;

        // Add click handlers
        document.querySelectorAll('.term-item').forEach(item => {
            item.addEventListener('click', function() {
                const term = this.dataset.term;
                handleTermClick(term);
            });
        });

        updateStatus(`Found ${relevantTerms.size} relevant terms`);
    }

    function handleTermClick(term) {
        if (isEditMode) {
            // Add brackets in edit mode
            const textarea = document.getElementById('wpTextbox1');
            if (textarea) {
                const wikilink = `[[${term}]]`;
                navigator.clipboard.writeText(wikilink).then(() => {
                    showToast(`Copied: ${wikilink}`);
                });
            }
        } else {
            // Navigate in read mode
            const url = `${window.location.origin}/wiki/${encodeURIComponent(term.replace(/ /g, '_'))}`;
            window.open(url, '_blank');
        }
    }

    function showToast(message) {
        const toast = document.createElement('div');
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed;
            bottom: 30px;
            right: 30px;
            background: #28a745;
            color: white;
            padding: 12px 20px;
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 10001;
            font-size: 13px;
            font-family: sans-serif;
        `;
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.style.transition = 'opacity 0.3s';
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }

    // ==================== EVENT HANDLERS ====================

    document.addEventListener('click', (e) => {
        if (e.target.dataset.hl !== undefined) {
            const term = e.target.dataset.term;
            
            if (isEditMode) {
                // Double-click to add brackets
                const wikilink = `[[${term}]]`;
                navigator.clipboard.writeText(wikilink).then(() => {
                    showToast(`Copied: ${wikilink}`);
                });
            } else {
                // Navigate
                const url = `${window.location.origin}/wiki/${encodeURIComponent(term.replace(/ /g, '_'))}`;
                if (e.ctrlKey || e.metaKey) {
                    window.open(url, '_blank');
                } else {
                    window.location.href = url;
                }
            }
        }
    });

    // ==================== INITIALIZATION ====================

    async function init() {
        currentArticle = getArticleTitle();
        isEditMode = checkEditMode();
        
        console.log('🚀 Wikipedia Smart Editor Assistant v5.0');
        console.log(`📄 Article: "${currentArticle}"`);
        console.log(`✏️ Edit Mode: ${isEditMode}`);

        loadCache();
        
        sidePanel = createSidePanel();
        
        if (isEditMode) {
            // Auto-open panel in edit mode
            sidePanel.style.transform = 'translateX(0px)';
            document.getElementById('togglePanel').textContent = '‹';
        }

        // Auto-analyze
        await analyzeAndBuildTermList();
        
        if (!isEditMode && highlightsEnabled) {
            applyHighlights();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
