// ==UserScript==
// @name         Wikipedia Smart Highlight Advanced
// @description  Highlights related Wikipedia articles using API and existing links
// @version      2.0
// @match        *://*.wikipedia.org/wiki/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  
  const CONFIG = {
    MAX_HIGHLIGHTS: 50,
    API_TIMEOUT: 5000,
    MIN_WORD_LENGTH: 4,
    DEBUG: true
  };

  const log = (...args) => CONFIG.DEBUG && console.log('[SmartHL]', ...args);
  
  // Check if we're on a main article page
  if (mw.config.get('wgNamespaceNumber') !== 0) {
    return log('Not a main article page');
  }

  const content = document.getElementById('mw-content-text');
  if (!content) {
    return log('No content area found');
  }

  log('Script started');
  injectStyle();

  // Main execution
  (async function main() {
    const pageTitle = mw.config.get('wgPageName');
    log('Current page:', pageTitle);

    // Step 1: Get existing links from the page (fast, no API)
    const existingLinks = extractExistingLinks(content);
    log('Existing links found:', existingLinks.size);

    // Step 2: Get related articles via Wikipedia API
    const apiLinks = await fetchRelatedArticles(pageTitle);
    log('API links found:', apiLinks.size);

    // Step 3: Combine both sources
    const allRelatedArticles = new Set([...existingLinks, ...apiLinks]);
    log('Total related articles:', allRelatedArticles.size);

    // Step 4: Extract capitalized words from article text
    const candidates = extractCandidateWords(content);
    log('Candidate words found:', candidates.length);

    // Step 5: Filter candidates to only those with Wikipedia articles
    const wordsToHighlight = filterByRelatedArticles(candidates, allRelatedArticles);
    log('Words to highlight:', wordsToHighlight.length);

    // Step 6: Highlight the words
    if (wordsToHighlight.length > 0) {
      highlightTerms(content, wordsToHighlight);
      log('Highlighting complete!');
    } else {
      log('No words to highlight');
    }
  })();

  // ===== CORE FUNCTIONS =====

  /**
   * Extract all existing Wikipedia links from the page
   */
  function extractExistingLinks(content) {
    const links = new Set();
    const linkElements = content.querySelectorAll('a[href^="/wiki/"]');
    
    linkElements.forEach(link => {
      const href = link.getAttribute('href');
      if (!href) return;
      
      // Skip special pages, files, categories
      if (href.includes(':')) return;
      
      // Extract title from URL: /wiki/Article_Name -> Article Name
      const title = decodeURIComponent(href.replace('/wiki/', ''))
        .replace(/_/g, ' ')
        .trim();
      
      if (title) links.add(title);
    });
    
    return links;
  }

  /**
   * Fetch related articles using Wikipedia API
   */
  async function fetchRelatedArticles(pageTitle) {
    const relatedArticles = new Set();
    
    try {
      // Get all links from the current page
      const linksData = await fetchWithTimeout(
        `https://en.wikipedia.org/w/api.php?` +
        `action=query&titles=${encodeURIComponent(pageTitle)}` +
        `&prop=links&pllimit=500&format=json&origin=*`,
        CONFIG.API_TIMEOUT
      );

      if (linksData?.query?.pages) {
        const pages = linksData.query.pages;
        const pageId = Object.keys(pages)[0];
        
        if (pages[pageId]?.links) {
          pages[pageId].links.forEach(link => {
            // Only include main namespace articles
            if (link.ns === 0) {
              relatedArticles.add(link.title);
            }
          });
        }
      }

      // Get categories and related articles (optional - can be slow)
      // Uncomment if you want even more related articles
      /*
      const categoriesData = await fetchWithTimeout(
        `https://en.wikipedia.org/w/api.php?` +
        `action=query&titles=${encodeURIComponent(pageTitle)}` +
        `&prop=categories&cllimit=50&format=json&origin=*`,
        CONFIG.API_TIMEOUT
      );
      
      if (categoriesData?.query?.pages) {
        const pages = categoriesData.query.pages;
        const pageId = Object.keys(pages)[0];
        
        if (pages[pageId]?.categories) {
          // You could fetch articles from these categories here
          log('Categories found:', pages[pageId].categories.length);
        }
      }
      */

    } catch (error) {
      log('API error:', error.message);
    }

    return relatedArticles;
  }

  /**
   * Extract capitalized words that could be article titles
   */
  function extractCandidateWords(content) {
    // Get only the main text, exclude infoboxes, references, etc.
    const textElements = content.querySelectorAll('p, li, td, th, dt, dd');
    const allText = Array.from(textElements)
      .map(el => el.textContent)
      .join(' ');

    // Find capitalized words (potential proper nouns)
    const capitalizedPattern = new RegExp(`\\b[A-Z][a-z]{${CONFIG.MIN_WORD_LENGTH - 1},}\\b`, 'g');
    const matches = allText.match(capitalizedPattern) || [];

    // Also find multi-word capitalized phrases (e.g., "Machine Learning")
    const phrasePattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;
    const phrases = allText.match(phrasePattern) || [];

    // Combine and deduplicate
    const candidates = [...new Set([...matches, ...phrases])];

    // Filter out common words that are unlikely to be articles
    const commonWords = new Set(['The', 'This', 'That', 'These', 'Those', 'There', 'When', 'Where', 'Which', 'What', 'However', 'Therefore', 'Thus', 'Hence']);
    
    return candidates.filter(word => !commonWords.has(word));
  }

  /**
   * Filter candidate words to only those that have Wikipedia articles
   */
  function filterByRelatedArticles(candidates, relatedArticles) {
    const wordsToHighlight = [];
    const relatedLower = new Map();
    
    // Create lowercase lookup map for case-insensitive matching
    relatedArticles.forEach(article => {
      relatedLower.set(article.toLowerCase(), article);
    });

    // Check each candidate
    candidates.forEach(candidate => {
      const candidateLower = candidate.toLowerCase();
      
      // Exact match
      if (relatedLower.has(candidateLower)) {
        wordsToHighlight.push({
          text: candidate,
          article: relatedLower.get(candidateLower)
        });
        return;
      }

      // Partial match (for multi-word phrases)
      for (const [articleLower, article] of relatedLower.entries()) {
        if (articleLower.includes(candidateLower) || candidateLower.includes(articleLower)) {
          wordsToHighlight.push({
            text: candidate,
            article: article
          });
          break;
        }
      }
    });

    // Limit to max highlights
    return wordsToHighlight.slice(0, CONFIG.MAX_HIGHLIGHTS);
  }

  /**
   * Highlight terms in the content
   */
  function highlightTerms(root, terms) {
    if (!terms.length) return;

    // Get all text nodes that should be processed
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: node => {
          if (!node.parentElement) return NodeFilter.FILTER_REJECT;
          
          // Skip if already inside a link, reference, or special element
          if (node.parentElement.closest('a, sup, .reference, .infobox, .thumb, script, style, code')) {
            return NodeFilter.FILTER_REJECT;
          }
          
          // Only process nodes with substantial text
          if (node.textContent.trim().length < 3) {
            return NodeFilter.FILTER_REJECT;
          }
          
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let highlightCount = 0;
    const processedNodes = new Set();

    while (walker.nextNode() && highlightCount < CONFIG.MAX_HIGHLIGHTS) {
      const node = walker.currentNode;
      
      // Skip if already processed
      if (processedNodes.has(node)) continue;
      
      let text = node.textContent;
      let modified = false;

      // Try to match each term
      for (const term of terms) {
        // Escape special regex characters in the search term
        const escapedText = term.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedText}\\b`, 'g');

        if (regex.test(text)) {
          text = text.replace(
            regex,
            `<mark class="smarthl" data-article="${term.article}" title="Related: [[${term.article}]]">$&</mark>`
          );
          modified = true;
          highlightCount++;
          
          if (highlightCount >= CONFIG.MAX_HIGHLIGHTS) break;
        }
      }

      // Replace node with highlighted version
      if (modified) {
        const span = document.createElement('span');
        span.innerHTML = text;
        node.parentNode.replaceChild(span, node);
        processedNodes.add(node);
      }
    }

    log('Highlights applied:', highlightCount);

    // Add click handlers for highlighted terms
    addClickHandlers();
  }

  /**
   * Add click handlers to open Wikipedia articles
   */
  function addClickHandlers() {
    document.querySelectorAll('mark.smarthl').forEach(mark => {
      mark.style.cursor = 'pointer';
      mark.addEventListener('click', (e) => {
        const article = mark.getAttribute('data-article');
        if (article) {
          const url = `/wiki/${encodeURIComponent(article.replace(/ /g, '_'))}`;
          if (e.ctrlKey || e.metaKey) {
            window.open(url, '_blank');
          } else {
            window.location.href = url;
          }
        }
      });
    });
  }

  /**
   * Inject CSS styles
   */
  function injectStyle() {
    const style = document.createElement('style');
    style.textContent = `
      mark.smarthl {
        background: linear-gradient(120deg, rgba(255, 200, 0, 0.3) 0%, rgba(255, 150, 0, 0.3) 100%);
        cursor: pointer;
        padding: 1px 3px;
        border-radius: 3px;
        transition: all 0.2s ease;
        border-bottom: 1px dotted rgba(255, 150, 0, 0.5);
      }
      mark.smarthl:hover {
        background: linear-gradient(120deg, rgba(255, 200, 0, 0.5) 0%, rgba(255, 150, 0, 0.5) 100%);
        border-bottom: 1px solid rgba(255, 150, 0, 0.8);
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Fetch with timeout
   */
  async function fetchWithTimeout(url, timeout) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

})();
