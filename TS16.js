// ==UserScript==
// @name         Highlight Unlinked Existing Terms
// @description  Highlights words in Wikipedia articles that are not linked but already have their own articles.
// @version      7.0
// @author       Riddhi
// @match        *://*.wikipedia.org/wiki/*
// ==/UserScript==

(function() {
    'use strict';

    // Configuration
    const CONFIG = {
        highlightColor: 'rgba(255, 235, 59, 0.3)',
        borderColor: '#ffc107',
        minWordLength: 4,
        batchSize: 15,
        delay: 200
    };

    let relevantTerms = new Map();
    let currentArticle = '';
    let isEditMode = false;
    let highlightsEnabled = true;
    let wordOccurrences = new Map();
    let sidePanel = null;
    let isProcessing = false;

    // ==================== UTILITY FUNCTIONS ====================

    function log(message) {
        console.log(`[WikiHelper] ${message}`);
    }

    function getArticleTitle() {
        const title = document.getElementById('firstHeading');
        if (!title) return '';
        return title.textContent.trim().replace(/\s*\[edit\]\s*$/i, '');
    }

    function checkEditMode() {
        return document.getElementById('wpTextbox1') !== null || 
               window.location.search.includes('action=edit');
    }

    function shouldExclude(word) {
        const lower = word.toLowerCase();
        const articleLower = currentArticle.toLowerCase();
        
        // Exclude current article
        if (lower === articleLower) return true;
        if (articleLower.includes(lower) || lower.includes(articleLower)) return true;
        
        // Exclude common words
        const exclude = ['january', 'february', 'march', 'april', 'may', 'june', 
                        'july', 'august', 'september', 'october', 'november', 'december',
                        'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
                        'the', 'and', 'or', 'but', 'with', 'from', 'this', 'that', 'these', 'those',
                        'wikipedia', 'retrieved', 'archived', 'original', 'external', 'references'];
        
        if (exclude.includes(lower)) return true;
        
        // Exclude numbers
        if (/^\d+$/.test(word)) return true;
        
        return false;
    }

    // ==================== FETCH ARTICLE DATA ====================

    async function fetchArticleLinks() {
        try {
            const apiUrl = `${window.location.origin}/w/api.php?action=query&titles=${encodeURIComponent(currentArticle)}&prop=links&format=json&origin=*&pllimit=500`;
            const response = await fetch(apiUrl);
            const data = await response.json();
            const pages = data.query.pages;
            const pageId = Object.keys(pages)[0];

            const links = new Set();
            if (pageId !== '-1' && pages[pageId].links) {
                pages[pageId].links.forEach(link => {
                    const term = link.title.replace(/_/g, ' ');
                    if (!term.includes(':')) {
                        links.add(term.toLowerCase());
                    }
                });
            }
            
            log(`Fetched ${links.size} article links`);
            return links;
        } catch (e) {
            log('Error fetching article links: ' + e);
            return new Set();
        }
    }

    async function checkTermsExist(terms) {
        if (terms.length === 0) return new Map();

        try {
            const titles = terms.join('|');
            const apiUrl = `${window.location.origin}/w/api.php?action=query&titles=${encodeURIComponent(titles)}&format=json&origin=*`;
            const response = await fetch(apiUrl);
            const data = await response.json();
            
            const existing = new Map();
            Object.values(data.query.pages).forEach(page => {
                if (page.pageid) {
                    existing.set(page.title.toLowerCase(), page.title);
                }
            });

            return existing;
        } catch (e) {
            log('Error checking terms: ' + e);
            return new Map();
        }
    }

    // ==================== WORD EXTRACTION ====================

    function extractWords(text) {
        const words = new Set();
        
        // Remove existing wikilinks
        text = text.replace(/\[\[.*?\]\]/g, '');
        
        // Single capitalized words
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
        
        return Array.from(words);
    }

    function trackOccurrences(text) {
        const words = extractWords(text);
        
        words.forEach(word => {
            const lower = word.toLowerCase();
            const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
            const matches = text.match(regex);
            
            if (matches) {
                if (!wordOccurrences.has(lower)) {
                    wordOccurrences.set(lower, 0);
                }
                wordOccurrences.set(lower, wordOccurrences.get(lower) + matches.length);
            }
        });
    }

    // ==================== ANALYSIS ====================

    async function analyzeArticle() {
        if (isProcessing) return;
        isProcessing = true;
        
        updateStatus('🔍 Analyzing...');
        log('Starting analysis...');
        
        // Clear previous data
        relevantTerms.clear();
        wordOccurrences.clear();
        
        // Get text
        let allText = '';
        if (isEditMode) {
            const textarea = document.getElementById('wpTextbox1');
            if (textarea) {
                allText = textarea.value;
            }
        } else {
            const paragraphs = document.querySelectorAll('#mw-content-text p');
            paragraphs.forEach(p => {
                allText += p.textContent + '\n';
            });
        }
        
        if (!allText.trim()) {
            updateStatus('❌ No text found');
            isProcessing = false;
            return;
        }
        
        // Track occurrences
        trackOccurrences(allText);
        log(`Tracked ${wordOccurrences.size} unique words`);
        
        // Fetch article links
        updateStatus('📡 Fetching links...');
        const articleLinks = await fetchArticleLinks();
        
        // Get all candidate words
        const allWords = extractWords(allText);
        log(`Found ${allWords.length} candidate words`);
        
        // Check existence in batches
        updateStatus('✅ Checking Wikipedia...');
        const batches = [];
        for (let i = 0; i < allWords.length; i += CONFIG.batchSize) {
            batches.push(allWords.slice(i, i + CONFIG.batchSize));
        }
        
        let processed = 0;
        for (const batch of batches) {
            const existing = await checkTermsExist(batch);
            
            existing.forEach((originalTerm, lowerTerm) => {
                // Calculate relevance score
                let score = 0;
                
                // High relevance: in article's links
                if (articleLinks.has(lowerTerm)) {
                    score += 0.8;
                } else {
                    score += 0.3; // Base score for existing Wikipedia article
                }
                
                // Bonus for multiple occurrences
                const occurrences = wordOccurrences.get(lowerTerm) || 1;
                if (occurrences > 1) {
                    score += Math.min(0.2, occurrences * 0.05);
                }
                
                relevantTerms.set(lowerTerm, {
                    original: originalTerm,
                    score: score,
                    count: occurrences
                });
            });
            
            processed += batch.length;
            updateStatus(`✅ Checked ${processed}/${allWords.length}...`);
            
            await new Promise(r => setTimeout(r, CONFIG.delay));
        }
        
        log(`Found ${relevantTerms.size} relevant terms`);
        updateSidePanel();
        
        if (!isEditMode && highlightsEnabled) {
            applyHighlights();
        }
        
        isProcessing = false;
        updateStatus(`✅ Found ${relevantTerms.size} terms`);
    }

    // ==================== HIGHLIGHTING ====================

    function applyHighlights() {
        const paragraphs = document.querySelectorAll('#mw-content-text p');
        
        paragraphs.forEach(p => {
            if (p.dataset.highlighted) return;
            if (p.textContent.trim().length < 50) return;
            
            highlightInElement(p);
            p.dataset.highlighted = 'true';
        });
    }

    function highlightInElement(element) {
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
            highlightTextNode(textNode);
        });
    }

    function highlightTextNode(textNode) {
        const text = textNode.textContent;
        const matches = [];

        relevantTerms.forEach((data, lowerTerm) => {
            const original = data.original;
            const regex = new RegExp(`\\b(${original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
            let match;
            
            while ((match = regex.exec(text)) !== null) {
                matches.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    text: match[0],
                    count: data.count
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
            const countBadge = m.count > 1 ? `<sup style="font-size: 9px; color: #666; margin-left: 2px;">${m.count}</sup>` : '';
            html += `<span data-hl data-term="${m.text}" style="background: ${CONFIG.highlightColor}; border-bottom: 2px solid ${CONFIG.borderColor}; cursor: pointer; padding: 1px 2px; border-radius: 2px;" title="Click to use this term">${m.text}${countBadge}</span>`;
            lastIdx = m.end;
        });
        html += text.substring(lastIdx);

        const wrapper = document.createElement('span');
        wrapper.innerHTML = html;
        textNode.parentNode.replaceChild(wrapper, textNode);
    }

    // ==================== UI ====================

    function createSidePanel() {
        const panel = document.createElement('div');
        panel.id = 'wiki-side-panel';
        panel.style.cssText = `
            position: fixed;
            right: 0;
            top: 100px;
            width: 300px;
            max-height: 70vh;
            background: white;
            border: 2px solid #0645ad;
            border-right: none;
            border-radius: 8px 0 0 8px;
            box-shadow: -4px 4px 12px rgba(0,0,0,0.2);
            z-index: 10000;
            font-family: sans-serif;
            display: flex;
            flex-direction: column;
            transform: translateX(300px);
            transition: transform 0.3s;
        `;

        panel.innerHTML = `
            <div style="background: #0645ad; color: white; padding: 10px 12px; font-weight: bold; display: flex; justify-content: space-between; align-items: center; font-size: 13px;">
                <span>🔗 Linkable Terms</span>
                <div>
                    <button id="toggleHL" style="background: rgba(255,255,255,0.2); border: 1px solid white; color: white; cursor: pointer; padding: 3px 8px; border-radius: 3px; margin-right: 4px; font-size: 11px;">
                        ${highlightsEnabled ? '👁️' : '🚫'}
                    </button>
                    <button id="refreshBtn" style="background: rgba(255,255,255,0.2); border: 1px solid white; color: white; cursor: pointer; padding: 3px 8px; border-radius: 3px; margin-right: 4px; font-size: 11px;">
                        🔄
                    </button>
                    <button id="toggleBtn" style="background: none; border: none; color: white; cursor: pointer; font-size: 16px; padding: 0;">‹</button>
                </div>
            </div>
            <div id="status-bar" style="padding: 6px 12px; background: #f8f9fa; border-bottom: 1px solid #ddd; font-size: 11px; color: #666;">
                Ready
            </div>
            <div id="term-list" style="flex: 1; overflow-y: auto; padding: 8px;">
                <div style="text-align: center; color: #999; padding: 30px 10px;">
                    Click 🔄 to analyze article
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        // Toggle panel
        document.getElementById('toggleBtn').addEventListener('click', () => {
            const isOpen = panel.style.transform === 'translateX(0px)';
            panel.style.transform = isOpen ? 'translateX(300px)' : 'translateX(0px)';
            document.getElementById('toggleBtn').textContent = isOpen ? '›' : '‹';
        });

        // Toggle highlights
        document.getElementById('toggleHL').addEventListener('click', () => {
            highlightsEnabled = !highlightsEnabled;
            document.getElementById('toggleHL').textContent = highlightsEnabled ? '👁️' : '🚫';
            
            if (highlightsEnabled) {
                applyHighlights();
            } else {
                document.querySelectorAll('[data-hl]').forEach(el => {
                    const text = el.textContent;
                    el.replaceWith(text);
                });
            }
        });

        // Refresh
        document.getElementById('refreshBtn').addEventListener('click', () => {
            analyzeArticle();
        });

        return panel;
    }

    function updateStatus(message) {
        const status = document.getElementById('status-bar');
        if (status) {
            status.textContent = message;
        }
    }

    function updateSidePanel() {
        const list = document.getElementById('term-list');
        if (!list) return;

        if (relevantTerms.size === 0) {
            list.innerHTML = '<div style="text-align: center; color: #999; padding: 30px 10px;">No relevant terms found</div>';
            return;
        }

        const sorted = Array.from(relevantTerms.entries())
            .sort((a, b) => b[1].score - a[1].score);

        let html = '<div style="font-size: 11px; color: #666; margin-bottom: 8px; padding: 0 4px;">Click term to copy [[link]]</div>';
        
        sorted.forEach(([lowerTerm, data]) => {
            const scorePercent = Math.round(data.score * 100);
            const color = scorePercent > 70 ? '#28a745' : scorePercent > 50 ? '#ffc107' : '#6c757d';
            
            html += `
                <div class="term-item" data-term="${data.original}" style="
                    margin: 6px 0;
                    padding: 8px 10px;
                    background: #f8f9fa;
                    border-left: 3px solid ${color};
                    border-radius: 3px;
                    cursor: pointer;
                    font-size: 12px;
                    transition: background 0.2s;
                " onmouseover="this.style.background='#e9ecef'" onmouseout="this.style.background='#f8f9fa'">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <strong style="color: #0645ad;">${data.original}</strong>
                        <span style="font-size: 10px; background: rgba(6,69,173,0.1); padding: 2px 5px; border-radius: 2px;">
                            ${data.count}x
                        </span>
                    </div>
                    <div style="font-size: 10px; color: #666; margin-top: 2px;">
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
                const wikilink = `[[${term}]]`;
                
                navigator.clipboard.writeText(wikilink).then(() => {
                    showToast(`✓ Copied: ${wikilink}`);
                });
            });
        });
    }

    function showToast(message) {
        const existing = document.getElementById('wiki-toast');
        if (existing) existing.remove();
        
        const toast = document.createElement('div');
        toast.id = 'wiki-toast';
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #28a745;
            color: white;
            padding: 10px 16px;
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
                const wikilink = `[[${term}]]`;
                navigator.clipboard.writeText(wikilink).then(() => {
                    showToast(`✓ Copied: ${wikilink}`);
                });
            } else {
                const url = `${window.location.origin}/wiki/${encodeURIComponent(term.replace(/ /g, '_'))}`;
                if (e.ctrlKey || e.metaKey) {
                    window.open(url, '_blank');
                } else {
                    window.location.href = url;
                }
            }
        }
    });

    // ==================== INIT ====================

    function init() {
        currentArticle = getArticleTitle();
        isEditMode = checkEditMode();
        
        log('Initialized');
        log(`Article: "${currentArticle}"`);
        log(`Edit Mode: ${isEditMode}`);

        sidePanel = createSidePanel();
        
        // Auto-open in edit mode
        if (isEditMode) {
            setTimeout(() => {
                sidePanel.style.transform = 'translateX(0px)';
                document.getElementById('toggleBtn').textContent = '‹';
            }, 500);
        }

        // Auto-analyze
        setTimeout(() => {
            analyzeArticle();
        }, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 100);
    }
})();
