const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Extract and evaluate JavaScript from the HTML file
function loadDiffMemoFunctions() {
    const htmlPath = path.join(__dirname, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');

    // Extract script content
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!scriptMatch) {
        throw new Error('Could not find script tag in HTML');
    }

    let scriptContent = scriptMatch[1];

    // Remove DOM-dependent code (event listeners, DOM queries)
    // We only want the pure functions
    scriptContent = scriptContent
        // Remove DOM element queries
        .replace(/const targetText = document\.getElementById.*?;/g, '')
        .replace(/const answerBox = document\.getElementById.*?;/g, '')
        .replace(/const checkButton = document\.getElementById.*?;/g, '')
        .replace(/const results = document\.getElementById.*?;/g, '')
        // Remove localStorage code
        .replace(/const savedTarget = localStorage\.getItem.*?;/g, '')
        .replace(/if \(savedTarget\) \{[\s\S]*?\}/g, '')
        // Remove event listeners
        .replace(/targetText\.addEventListener[\s\S]*?\}\);/g, '')
        .replace(/checkButton\.addEventListener[\s\S]*?\}\);/g, '')
        .replace(/answerBox\.addEventListener[\s\S]*?\}\);/g, '');

    // Create a context with necessary globals
    const context = {
        Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
        document: {
            createElement: (tag) => ({
                textContent: '',
                get innerHTML() {
                    // Simple HTML escaping
                    return this.textContent
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;');
                }
            })
        },
        // Export functions we want to test
        exports: {}
    };

    // Add export statements for the functions we want to test
    scriptContent += `
        exports.normalizeWord = normalizeWord;
        exports.tokenize = tokenize;
        exports.computeLCS = computeLCS;
        exports.generateDiff = generateDiff;
        exports.escapeHtml = escapeHtml;
        exports.getTextFromContentEditable = getTextFromContentEditable;
    `;

    vm.createContext(context);
    vm.runInContext(scriptContent, context);

    return context.exports;
}

describe('DiffMemo', () => {
    let funcs;

    beforeAll(() => {
        funcs = loadDiffMemoFunctions();
    });

    describe('normalizeWord', () => {
        test('converts to lowercase', () => {
            expect(funcs.normalizeWord('Hello')).toBe('hello');
            expect(funcs.normalizeWord('WORLD')).toBe('world');
        });

        test('strips leading punctuation', () => {
            expect(funcs.normalizeWord('"Hello')).toBe('hello');
            expect(funcs.normalizeWord('(test')).toBe('test');
        });

        test('strips trailing punctuation', () => {
            expect(funcs.normalizeWord('Hello!')).toBe('hello');
            expect(funcs.normalizeWord('test,')).toBe('test');
            expect(funcs.normalizeWord('end.')).toBe('end');
        });

        test('strips both leading and trailing punctuation', () => {
            expect(funcs.normalizeWord('"Hello!"')).toBe('hello');
            expect(funcs.normalizeWord('(test)')).toBe('test');
        });

        test('preserves internal punctuation', () => {
            expect(funcs.normalizeWord("don't")).toBe("don't");
            expect(funcs.normalizeWord('e-mail')).toBe('e-mail');
        });
    });

    describe('tokenize', () => {
        test('splits text into word tokens', () => {
            const tokens = funcs.tokenize('Hello world');
            expect(tokens).toHaveLength(2);
            expect(tokens[0].original).toBe('Hello');
            expect(tokens[1].original).toBe('world');
        });

        test('preserves original word forms', () => {
            const tokens = funcs.tokenize('Hello, World!');
            expect(tokens[0].original).toBe('Hello,');
            expect(tokens[1].original).toBe('World!');
        });

        test('includes normalized forms', () => {
            const tokens = funcs.tokenize('Hello, World!');
            expect(tokens[0].normalized).toBe('hello');
            expect(tokens[1].normalized).toBe('world');
        });

        test('tracks character positions', () => {
            const tokens = funcs.tokenize('Hello world');
            expect(tokens[0].start).toBe(0);
            expect(tokens[0].end).toBe(5);
            expect(tokens[1].start).toBe(6);
            expect(tokens[1].end).toBe(11);
        });

        test('handles multiple spaces', () => {
            const tokens = funcs.tokenize('Hello   world');
            expect(tokens).toHaveLength(2);
            expect(tokens[1].start).toBe(8);
        });

        test('handles newlines', () => {
            const tokens = funcs.tokenize('Hello\nworld');
            expect(tokens).toHaveLength(2);
            expect(tokens[0].original).toBe('Hello');
            expect(tokens[1].original).toBe('world');
        });
    });

    describe('computeLCS', () => {
        test('finds exact matches', () => {
            const target = funcs.tokenize('The quick brown fox');
            const answer = funcs.tokenize('The quick brown fox');
            const { targetMatches, answerMatches } = funcs.computeLCS(target, answer);

            expect(targetMatches.size).toBe(4);
            expect(answerMatches.size).toBe(4);
        });

        test('identifies extra words in answer', () => {
            const target = funcs.tokenize('The brown fox');
            const answer = funcs.tokenize('The quick brown fox');
            const { targetMatches, answerMatches } = funcs.computeLCS(target, answer);

            // "quick" at index 1 should not be matched
            expect(answerMatches.has(1)).toBe(false);
            // Other words should match
            expect(answerMatches.has(0)).toBe(true); // The
            expect(answerMatches.has(2)).toBe(true); // brown
            expect(answerMatches.has(3)).toBe(true); // fox
        });

        test('identifies missing words from target', () => {
            const target = funcs.tokenize('The quick brown fox');
            const answer = funcs.tokenize('The brown fox');
            const { targetMatches, answerMatches } = funcs.computeLCS(target, answer);

            // "quick" at target index 1 should not be matched
            expect(targetMatches.has(1)).toBe(false);
            // Other words should match
            expect(targetMatches.has(0)).toBe(true);
            expect(targetMatches.has(2)).toBe(true);
            expect(targetMatches.has(3)).toBe(true);
        });

        // REGRESSION TEST: Left-to-right matching
        test('matches words left-to-right when duplicates exist', () => {
            const target = funcs.tokenize('The quick brown fox jumped over the lazy dog');
            const answer = funcs.tokenize('The');
            const { targetMatches, answerMatches } = funcs.computeLCS(target, answer);

            // Should match the FIRST "The" (index 0), not the second "the" (index 6)
            expect(targetMatches.has(0)).toBe(true);
            expect(targetMatches.has(6)).toBe(false);
            expect(answerMatches.has(0)).toBe(true);
        });

        test('matches multiple duplicate words left-to-right', () => {
            const target = funcs.tokenize('the cat and the dog and the bird');
            const answer = funcs.tokenize('the the');
            const { targetMatches, answerMatches } = funcs.computeLCS(target, answer);

            // Should match indices 0 and 3 (first two "the"s), not 3 and 6 or 0 and 6
            expect(targetMatches.has(0)).toBe(true);
            expect(targetMatches.has(3)).toBe(true);
            expect(targetMatches.has(6)).toBe(false);
        });

        test('handles case-insensitive matching', () => {
            const target = funcs.tokenize('The Quick Brown');
            const answer = funcs.tokenize('the quick brown');
            const { targetMatches, answerMatches } = funcs.computeLCS(target, answer);

            expect(targetMatches.size).toBe(3);
            expect(answerMatches.size).toBe(3);
        });
    });

    describe('generateDiff', () => {
        function getDiff(targetText, answerText) {
            const targetTokens = funcs.tokenize(targetText);
            const answerTokens = funcs.tokenize(answerText);
            const matches = funcs.computeLCS(targetTokens, answerTokens);
            return funcs.generateDiff(targetTokens, answerTokens, answerText, matches);
        }

        test('returns no errors for exact match', () => {
            const diff = getDiff('The quick brown fox', 'The quick brown fox');
            expect(diff.extraCount).toBe(0);
            expect(diff.missingCount).toBe(0);
        });

        test('counts extra words', () => {
            const diff = getDiff('The brown fox', 'The quick brown fox');
            expect(diff.extraCount).toBe(1);
            expect(diff.missingCount).toBe(0);
        });

        test('counts missing words', () => {
            const diff = getDiff('The quick brown fox', 'The brown fox');
            expect(diff.extraCount).toBe(0);
            expect(diff.missingCount).toBe(1);
        });

        test('highlights extra words with yellow', () => {
            const diff = getDiff('The brown fox', 'The quick brown fox');
            expect(diff.html).toContain('<span class="extra">quick</span>');
        });

        test('inserts missing placeholders', () => {
            const diff = getDiff('The quick brown fox', 'The brown fox');
            expect(diff.html).toContain('<span class="missing"></span>');
        });

        test('preserves original whitespace', () => {
            const diff = getDiff('The quick brown fox', 'The   brown   fox');
            // Multiple spaces should be preserved (they appear after the placeholder for "quick")
            // The original "   " between "The" and "brown" in user input should be intact
            expect(diff.html).toContain('</span>   brown');
            // And the spaces between "brown" and "fox"
            expect(diff.html).toContain('brown   fox');
        });

        // REGRESSION TEST: No artificial space accumulation
        test('does not add artificial trailing spaces after missing placeholders', () => {
            const diff = getDiff(
                'The quick brown fox jumped over the lazy dog',
                'The quick brown fox jumped lazy dog'
            );

            // Two missing words (over, the) should produce two adjacent placeholders
            // with NO space between them (spaces only come from user's original text)
            expect(diff.html).toContain('</span><span class="missing">');

            // The only space after a </span> should be the user's original space before "lazy"
            const spansWithTrailingSpace = (diff.html.match(/<\/span> /g) || []).length;
            expect(spansWithTrailingSpace).toBe(1); // Just the user's original space
        });

        test('repeated diff generation does not accumulate spaces', () => {
            // Simulate checking answer multiple times
            const targetText = 'The quick brown fox jumped over the lazy dog';
            let answerText = 'The quick brown fox jumped lazy dog';

            // First diff
            let diff = getDiff(targetText, answerText);

            // Extract text content from HTML (simulating what getTextFromContentEditable does)
            // Remove HTML tags to get plain text
            let extractedText = diff.html
                .replace(/<span class="missing"><\/span>/g, '')
                .replace(/<span class="extra">(.*?)<\/span>/g, '$1')
                .replace(/<br>/g, '\n')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&')
                .replace(/&quot;/g, '"');

            // Second diff with extracted text
            let diff2 = getDiff(targetText, extractedText);

            // The text should be the same, no accumulated spaces
            let extractedText2 = diff2.html
                .replace(/<span class="missing"><\/span>/g, '')
                .replace(/<span class="extra">(.*?)<\/span>/g, '$1')
                .replace(/<br>/g, '\n')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&')
                .replace(/&quot;/g, '"');

            expect(extractedText2).toBe(extractedText);

            // Counts should remain the same
            expect(diff2.extraCount).toBe(diff.extraCount);
            expect(diff2.missingCount).toBe(diff.missingCount);
        });

        test('handles newlines in answer text', () => {
            const diff = getDiff(
                'The quick brown fox',
                'The quick\nbrown fox'
            );
            expect(diff.extraCount).toBe(0);
            expect(diff.missingCount).toBe(0);
            // Newline should be preserved (converted to <br>)
            expect(diff.html).toContain('<br>');
        });

        test('case differences are ignored', () => {
            const diff = getDiff('The Quick Brown Fox', 'the quick brown fox');
            expect(diff.extraCount).toBe(0);
            expect(diff.missingCount).toBe(0);
        });

        test('punctuation differences are ignored', () => {
            const diff = getDiff('Hello, world!', 'Hello world');
            expect(diff.extraCount).toBe(0);
            expect(diff.missingCount).toBe(0);
        });
    });

    describe('escapeHtml', () => {
        test('escapes HTML special characters', () => {
            expect(funcs.escapeHtml('<script>')).toBe('&lt;script&gt;');
            expect(funcs.escapeHtml('a & b')).toBe('a &amp; b');
            expect(funcs.escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
        });

        test('converts newlines to br tags', () => {
            expect(funcs.escapeHtml('line1\nline2')).toBe('line1<br>line2');
        });
    });
});
