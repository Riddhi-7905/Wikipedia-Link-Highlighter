/**
 * User:Herdaisymione/userscripts/highlight-unlinked-terms.js
 * Description: A universal script to find and highlight terms on any Wikipedia page that have existing articles 
 */

mw.hook('wikipage.content').add(function($content) {

    // Core Vision & Configuration
    // The goal is a universal script. This config will eventually be powered by the user's Babel box.
    // For now, we are testing with English ('en') Wikipedia. We can add 'hi', 'gu', 'ru' etc. later.
    const config = {
        languages: ['en'], // TODO: Later, get this from the user's Babel box on their user page.
        apiBatchSize: 50
    };

    // Standard checks: run only on articles in view mode.
    if (mw.config.get("wgNamespaceNumber") !== 0 || mw.config.get("wgAction") !== "view") {
        return;
    }
    
    // --- Styling ---
    // Reverted to a simple red highlight as per the basic plan. No dotted lines.
    const style = document.createElement("style");
    style.textContent = `
        mark.unlinked-term {
            background-color: #ffecec; /* Light red */
            color: #b30000;          /* Dark red text */
            border-radius: 3px;
            padding: 1px 3px;
            cursor: help;
        }
        mark.unlinked-term:hover {
            background-color: #ffd6d6;
        }
    `;
    document.head.appendChild(style);

    // Main Logic 
    // The new strategy is to ONLY search within the main article paragraphs (<p> tags).
    // This naturally ignores infoboxes, tables, headers, and other junk without complex code.
    const paragraphs = $content[0].querySelectorAll(':scope > p');
    if (!paragraphs || paragraphs.length === 0) {
        return; // No paragraphs, nothing to do.
    }

    // Helper to get text nodes from an element.
    function collectTextNodes(element, nodes = []) {
        for (const node of element.childNodes) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) {
                nodes.push(node);
            } else if (node.nodeType === Node.ELEMENT_NODE && !["A", "SUP", "SUB", "CITE", "MARK"].includes(node.tagName)) {
                collectTextNodes(node, nodes);
            }
        }
        return nodes;
    }

    // 1. Find all potential candidate terms, ONLY from paragraphs.
    const textNodesInParagraphs = Array.from(paragraphs).flatMap(p => collectTextNodes(p));
    const candidateWords = new Set();
    
    // Scrapped the "Find Capitalized Words" logic. 
    // This new regex finds multi-word phrases (1-3 words) that look like potential terms.
    // It's language-agnostic and doesn't rely on capitalization.
    const termRegex = /\b([a-zA-ZÀ-ž-']{4,}(?:\s[a-zA-ZÀ-ž-']{2,}){0,2})\b/g;

    textNodesInParagraphs.forEach(node => {
        const matches = node.textContent.match(termRegex);
        if (matches) {
            matches.forEach(term => candidateWords.add(term.trim()));
        }
    });

    if (candidateWords.size === 0) return;

    // 2. Check the API for all configured languages.
    const api = new mw.Api();
    const finalTermsToHighlight = new Set();
    const allApiPromises = [];

    // Loop through each language specified in the config.
    config.languages.forEach(lang => {
        const wordsToCheck = Array.from(candidateWords);
        for (let i = 0; i < wordsToCheck.length; i += config.apiBatchSize) {
            const chunk = wordsToCheck.slice(i, i + config.apiBatchSize);
            
            // Construct the correct API URL for the target language Wikipedia.
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
            }).then(result => {
                if (!result.query || !result.query.pages) return;
                result.query.pages.forEach(page => {
                    if (!page.missing && !page.pageprops?.disambiguation) {
                        const redirect = result.query.redirects?.find(r => r.to === page.title);
                        // If an article exists on the target wiki, we add the original term to our highlight list.
                        finalTermsToHighlight.add(redirect ? redirect.from : page.title);
                    }
                });
            });
            allApiPromises.push(apiPromise);
        }
    });

    // 3. After all API checks for all languages are complete, highlight the terms.
    Promise.all(allApiPromises).then(() => {
        if (finalTermsToHighlight.size === 0) return;

        // Highlight only the FIRST occurrence of each valid term.
        const highlightedOnce = new Set();
        textNodesInParagraphs.forEach(node => {
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
                    hasChanges = true;
                    fragment.appendChild(document.createTextNode(originalText.slice(lastIndex, match.index)));
                    
                    highlightedOnce.add(term);
                    const mark = document.createElement("mark");
                    mark.className = "unlinked-term";
                    mark.textContent = term;
                    mark.title = `An article for “${term}” exists. Consider creating a link.`;
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
