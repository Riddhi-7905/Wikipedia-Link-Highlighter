/**
 * User:Herdaisymione/userscripts/highlight-unlinked-terms.js
 * 

// using mw.hook to make sure the script only runs after the page content is fully loaded and ready.
// This solves all timing issues.
mw.hook('wikipage.content').add(function($content) {

    // Basic checks: only run on articles, and only in view mode.
    if (mw.config.get("wgNamespaceNumber") !== 0 || mw.config.get("wgAction") !== "view") {
        return;
    }

    // Configuration
    // This will eventually be powered by the user's Babel box. For now, we are testing with English ('en').
    const TARGET_LANGUAGES = ['en']; 
    const API_BATCH_SIZE = 50;

    // Styling
    // Simple red highlight. No dotted lines or other effects.
    const style = document.createElement("style");
    style.textContent = `
        mark.unlinked-term-ayush { /* Using a unique class name to avoid conflicts */
            background-color: #ffecec; /* Light red */
            color: #b30000;          /* Dark red text */
            border-radius: 3px;
            padding: 1px 2px;
            cursor: help;
        }
    `;
    document.head.appendChild(style);

    // Instead of scanning everything and blacklisting junk, we now ONLY get the main paragraphs (<p> tags).
    // This automatically ignores infoboxes, tables, headers, etc. 
    const paragraphs = $content[0].querySelectorAll(':scope > p');
    if (!paragraphs || paragraphs.length === 0) {
        return; // No paragraphs on the page, nothing to do.
    }

    // Helper function to get all text nodes from a given element.
    function collectTextNodes(element, nodes = []) {
        for (const node of element.childNodes) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 1) { // Ignore single characters
                nodes.push(node);
            } else if (node.nodeType === Node.ELEMENT_NODE && !["A", "SUP", "SUB", "CITE", "MARK"].includes(node.tagName)) {
                collectTextNodes(node, nodes);
            }
        }
        return nodes;
    }

    // 1. Finding all potential terms from the paragraphs.
    const textNodesInParagraphs = Array.from(paragraphs).flatMap(p => collectTextNodes(p));
    const candidateTerms = new Set();
    
    // This regex is smarter. It doesn't rely on capitalization. It looks for 1-to-3-word phrases
    // that look like potential terms. This is more language-agnostic.
    const termRegex = /\b[A-Za-zÀ-ž-']{4,}(?:\s[A-Za-zÀ-ž-']{2,}){0,2}\b/g;

    textNodesInParagraphs.forEach(node => {
        const matches = node.textContent.match(termRegex);
        if (matches) {
            matches.forEach(term => {
                // Simple filter to avoid very generic, single-word matches.
                if (term.includes(' ') || term.length > 5) {
                    candidateTerms.add(term.trim());
                }
            });
        }
    });

    // Don't run if we didn't find any good candidates.
    if (candidateTerms.size === 0) return;

    // 2. Check the API for all configured languages.
    const finalTermsToHighlight = new Set();
    const allApiPromises = [];

    // This loop is for the Babel Box vision. For now, it just runs for 'en'.
    TARGET_LANGUAGES.forEach(lang => {
        const wordsToCheck = Array.from(candidateTerms);
        for (let i = 0; i < wordsToCheck.length; i += API_BATCH_SIZE) {
            const chunk = wordsToCheck.slice(i, i + API_BATCH_SIZE);
            
            // Using jQuery ajax as it's reliable in MediaWiki environment.
            const apiPromise = $.ajax({
                url: `https://${lang}.wikipedia.org/w/api.php`,
                dataType: 'jsonp',
                data: {
                    action: 'query',
                    format: 'json',
                    titles: chunk.join('|'),
                    prop: 'pageprops',
                    ppprop: 'disambiguation',
                    redirects: 1,
                    formatversion: 2
                }
            }).done(result => {
                if (!result.query || !result.query.pages) return;
                result.query.pages.forEach(page => {
                    if (!page.missing && !page.pageprops?.disambiguation) {
                        const redirect = result.query.redirects?.find(r => r.to === page.title);
                        finalTermsToHighlight.add(redirect ? redirect.from : page.title);
                    }
                });
            });
            allApiPromises.push(apiPromise);
        }
    });


    // 3. After ALL API checks are done, highlighting starts.
    Promise.all(allApiPromises).then(() => {
        if (finalTermsToHighlight.size === 0) return;

        // This makes sure we only highlight each term ONCE per page.
        const highlightedOnce = new Set();
        
        // only loop through the paragraph text nodes.
        textNodesInParagraphs.forEach(node => {
            // Safety check: don't touch anything inside an existing link or mark.
            if (node.parentElement.closest('A, SUP, CITE, MARK')) return;

            const fragment = document.createDocumentFragment();
            const originalText = node.textContent;
          
            const escapedTerms = Array.from(finalTermsToHighlight).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            if (escapedTerms.length === 0) return;
            const highlightRegex = new RegExp(`\\b(${escapedTerms.join('|')})\\b`, 'g');
            
            let lastIndex = 0;
            let hasChanges = false;
            let match;

            while ((match = highlightRegex.exec(originalText)) !== null) {
                const term = match[0];
                if (finalTermsToHighlight.has(term) && !highlightedOnce.has(term)) {
                    hasChanges = true;                    fragment.appendChild(document.createTextNode(originalText.slice(lastIndex, match.index)));
                    
                    highlightedOnce.add(term); // Mark as highlighted
                    
                    const mark = document.createElement("mark");
                    mark.className = "unlinked-term-ayush";
                    mark.textContent = term;
                    mark.title = `An article for “${term}” exists. Consider adding a link.`;
                    fragment.appendChild(mark);

                    lastIndex = match.index + term.length;
                }
            }

            if (hasChanges) {
                fragment.appendChild(document.createTextNode(originalText.slice(lastIndex)));
                node.replaceWith(fragment);
            }
        });
    }).catch(error => {
        console.error("Highlight Unlinked Terms script failed:", error);
    });

});
