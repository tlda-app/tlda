#!/usr/bin/env python3
"""
Grammar linter for .tex files using spaCy.

Substitutes ALL math (inline and display alike) with grammatically typed
English placeholders so spaCy can check sentence structure:
  - Math terms → "M" (noun placeholder)
  - Relation operators → English verbs ("equals", "is at most", …)
  - \\qwhere/\\qfor/\\qand → their English words

Display environment tags are stripped so display content flows into the same
text stream as prose. The display/inline distinction is irrelevant to grammar.

Rules detected:
  colon-before-display     — colon immediately before display math
  comma-before-display     — comma immediately before display math
  comma-before-conjunction — comma before \\qwhere/\\qfor/\\qand

Usage:
    python3 lint-typography.py <tex-file>
Output:
    JSON array of {file, line, kind, snippet} to stdout.
"""

import json
import re
import sys

import spacy

# --------------------------------------------------------------------------
# LaTeX environment / structure regexes
# --------------------------------------------------------------------------

_DISPLAY_ENVS = (
    r'equation\*?|align\*?|gather\*?|multline\*?|'
    r'eqnarray\*?|flalign\*?|alignat\*?|subequations|cases'
)
ENV_BEGIN_RE  = re.compile(rf'\\begin\{{({_DISPLAY_ENVS})\}}')
ENV_END_RE    = re.compile(rf'\\end\{{({_DISPLAY_ENVS})\}}')
DISPLAY_OPEN  = re.compile(r'^\s*\\\[')
DISPLAY_CLOSE = re.compile(r'^\s*\\\]')
# Unanchored close: for a display opened and closed on the SAME line (\[ ... \]),
# the leading \[ is already stripped, so the \] sits at the end of the body, not
# the start. The anchored DISPLAY_CLOSE would miss it; use this to detect it.
DISPLAY_CLOSE_ANY = re.compile(r'\\\]')
COMMENT_RE    = re.compile(r'(?<!\\)%.*$')

# Inline math — greedily matches $...$ and $$...$$
INLINE_MATH_RE = re.compile(r'\$\$[^$]*\$\$|\$[^$\n]*\$')

# \\q-conjunction macros (inside math, never in prose)
CONJUNCTION_RE = re.compile(r'\\q(where|for|and)\b')

# Comma immediately before \\qwhere/\\qfor/\\qand in the source
COMMA_CONJ_RE = re.compile(r',\s*\\q(where|for|and)\b')

# --------------------------------------------------------------------------
# Substitution helpers
# --------------------------------------------------------------------------

def strip_comment(line: str) -> str:
    return COMMENT_RE.sub('', line).rstrip()


def _math_to_english(s: str) -> str:
    """
    Replace LaTeX math tokens with English placeholders.

    Done in a single pass using a substitution function so that we can
    expand relation operators into English verbs before replacing the
    remaining identifiers/commands with the noun placeholder "M".

    \\q-macros are expanded to their English words FIRST (before the
    identifier-replacement pass) so they don't get clobbered.
    """
    # 1. Expand conjunction macros to English
    s = CONJUNCTION_RE.sub(lambda m: m.group(1), s)  # \qwhere → where, etc.

    # 2. Expand relation operators to English verbs
    s = re.sub(r'\\(?:le|leq|leqslant)\b', ' is_at_most ', s)
    s = re.sub(r'\\(?:ge|geq|geqslant)\b', ' is_at_least ', s)
    s = re.sub(r'\\(?:ne|neq)\b',          ' is_not ',      s)
    s = re.sub(r'\\in\b',                  ' in ',          s)
    s = re.sub(r'\\notin\b',               ' not_in ',      s)
    s = re.sub(r'(?<![=<>!])=(?!=)',       ' equals ',      s)
    s = re.sub(r'\\approx\b',             ' approximately_equals ', s)

    # 3. Strip alignment markers and line-break macros
    s = re.sub(r'\\\\', ' ', s)
    s = re.sub(r'&', ' ', s)

    # 4. Protect known English words from the identifier sweep below.
    #    These come from conjunction expansion or relation-verb substitution.
    KEEP_WORDS = {'where', 'for', 'and', 'in', 'not_in',
                  'equals', 'is_at_most', 'is_at_least', 'is_not',
                  'approximately_equals'}
    # Tokenize and rebuild, replacing only non-kept tokens
    def replace_token(tok):
        # Multi-word tokens (underscored) are our synthetic verbs — keep them
        if '_' in tok:
            return tok
        if tok.lower() in KEEP_WORDS:
            return tok
        # LaTeX command
        if tok.startswith('\\'):
            return 'M'
        # Pure alphabetic identifier → noun placeholder
        if re.fullmatch(r'[a-zA-Z]\w*', tok):
            return 'M'
        # Number → noun placeholder
        if re.fullmatch(r'\d+\.?\d*(?:[eE][+-]?\d+)?', tok):
            return 'M'
        return tok

    tokens = re.split(r'(\s+)', s)
    rebuilt = []
    for tok in tokens:
        if re.fullmatch(r'\s+', tok):
            rebuilt.append(tok)
            continue
        # The tok may be a compound like "\\frac{1}{2}" — extract the command
        # part and replace the whole thing, since we already stripped args above
        m = re.match(r'\\[a-zA-Z*]+(?:\{[^}]*\}|\[[^\]]*\])*', tok)
        if m:
            rebuilt.append('M')
            continue
        rebuilt.append(replace_token(tok))

    s = ''.join(rebuilt)
    # Clean up punctuation that's purely structural in LaTeX
    s = re.sub(r'[{}()\[\]^_]', ' ', s)
    s = re.sub(r'\s+', ' ', s)
    return s.strip()


def substitute_inline_math(line: str) -> str:
    """Replace $...$ spans and common LaTeX wrappers in a prose line."""
    s = INLINE_MATH_RE.sub(lambda m: ' ' + _math_to_english(m.group()[1:-1]) + ' ', line)
    # Strip common text wrappers, keeping their content
    s = re.sub(r'\\(?:emph|textbf|textit|texttt|text)\{([^}]*)\}', r' \1 ', s)
    s = re.sub(r'\\(?:cite[ptes]?|ref|eqref|label|cref|Cref|autoref|pageref)\{[^}]*\}', ' ', s)
    # Strip other macro calls without losing their arguments as noise
    s = re.sub(r'\\[a-zA-Z]+\*?(?:\{[^}]*\}|\[[^\]]*\])*', ' ', s)
    s = re.sub(r'\s+', ' ', s)
    return s.strip()


# --------------------------------------------------------------------------
# Build a substituted text with line-number tracking
# --------------------------------------------------------------------------

def build_substituted_lines(raw_lines):
    """
    Yield (orig_lineno, substituted_text) for each original line.

    Display environment tags are stripped and their content is processed with
    _math_to_english so it flows into the text stream.  Inline math in prose
    lines is substituted via substitute_inline_math.
    """
    in_display = False
    bracket_depth = 0

    for i, raw in enumerate(raw_lines, start=1):
        line = strip_comment(raw)

        if in_display:
            if ENV_END_RE.search(line):
                in_display = False
                continue          # skip the \end tag line itself
            if DISPLAY_CLOSE.match(line.strip()):
                bracket_depth = max(0, bracket_depth - 1)
                if bracket_depth == 0:
                    in_display = False
                continue          # skip the \] line itself
            # Inside display — substitute math, keep conjunctions as English
            subst = _math_to_english(line)
            if subst:
                yield (i, subst)
            continue

        if ENV_BEGIN_RE.search(line):
            in_display = True
            # Yield a BEGIN sentinel so callers can detect display boundaries
            yield (i, '__DISPLAY__')
            continue
        if DISPLAY_OPEN.match(line.strip()):
            in_display = True
            bracket_depth += 1
            yield (i, '__DISPLAY__')
            continue

        if not line.strip() or line.strip().startswith('%'):
            yield (i, '')
            continue

        # Prose line
        subst = substitute_inline_math(line)
        if subst:
            yield (i, subst)
        else:
            yield (i, '')


# --------------------------------------------------------------------------
# Pre-pass: comma/colon before display (structural, no spaCy needed)
# --------------------------------------------------------------------------

def check_punct_before_display(raw_lines, file_label):
    """
    Detect prose line ending with ':' or ',' immediately before a display.
    (Walks the original source; display/inline distinction fully captured by
    LaTeX structure.)
    """
    findings = []

    def is_display_opener(line):
        s = line.strip()
        return bool(DISPLAY_OPEN.match(s) or ENV_BEGIN_RE.search(s))

    def is_blank_or_comment(line):
        s = line.strip()
        return s == '' or s.startswith('%')

    for i, line in enumerate(raw_lines):
        stripped = strip_comment(line)
        if not (stripped.endswith(':') or stripped.endswith(',')):
            continue
        punct = stripped[-1]
        j = i + 1
        while j < len(raw_lines) and is_blank_or_comment(raw_lines[j]):
            j += 1
        if j < len(raw_lines) and is_display_opener(raw_lines[j]):
            kind = 'colon-before-display' if punct == ':' else 'comma-before-display'
            findings.append({
                'file': file_label,
                'line': i + 1,
                'kind': kind,
                'snippet': stripped[-60:].strip(),
            })
    return findings


# --------------------------------------------------------------------------
# Pre-pass: comma before \\q-conjunction (structural, no spaCy needed)
# --------------------------------------------------------------------------

def check_comma_before_conjunction(raw_lines, file_label):
    """
    Detect comma before \\qwhere/\\qfor/\\qand anywhere in the source.
    These macros only appear inside math, so any comma before them is wrong.
    """
    findings = []
    for i, line in enumerate(raw_lines, start=1):
        m = COMMA_CONJ_RE.search(line)
        if m:
            snippet = line[max(0, m.start() - 20):m.start() + 40].strip()
            findings.append({
                'file': file_label,
                'line': i,
                'kind': 'comma-before-conjunction',
                'snippet': snippet,
            })
    return findings


# --------------------------------------------------------------------------
# Pre-pass: "by [property]" passive mechanism pattern
# --------------------------------------------------------------------------

# Common math property nouns that follow "by" in the banned pattern.
# This list catches the most frequent offenders; capitalized names
# (Cauchy-Schwarz, Lemma, Proposition, etc.) are caught separately.
_BY_PROPERTIES = (
    'regularity', 'continuity', 'boundedness', 'convexity', 'linearity',
    'monotonicity', 'symmetry', 'duality', 'compactness', 'completeness',
    'dominated convergence', 'uniform convergence', 'convergence',
    'induction', 'contradiction', 'construction', 'inspection',
    'hypothesis', 'assumption', 'stationarity', 'measurability',
    'integrability', 'orthogonality', 'positivity', 'subadditivity',
    'superadditivity', 'homogeneity', 'concavity', 'separability',
    'independence', 'exchangeability', 'sufficiency', 'optimality',
    'equicontinuity', 'uniform integrability',
)

# "by" + capitalized word (Cauchy-Schwarz, Lemma, etc.) or \Cref/\ref
_BY_CAP_RE = re.compile(
    r'\bby\s+'
    r'(?:'
    r'(?:the\s+)?[A-Z][a-zA-Z-]*'       # capitalized name
    r'|\\(?:Cref|cref|ref|eqref)\{'      # \Cref{...}, \ref{...}
    r')',
    re.IGNORECASE
)

# "by" + known property noun (case-insensitive)
_BY_PROP_PATTERN = re.compile(
    r'\bby\s+(?:the\s+)?(?:' +
    '|'.join(re.escape(p) for p in sorted(_BY_PROPERTIES, key=len, reverse=True)) +
    r')\b',
    re.IGNORECASE
)

# Whitelist: "by definition" is OK
_BY_WHITELIST_RE = re.compile(r'\bby\s+definition\b', re.IGNORECASE)


def check_by_property(raw_lines, file_label):
    """
    Detect 'by [property]' passive-mechanism constructions.
    Flags lines where the author names a tool without showing how it applies.
    """
    findings = []
    in_display = False

    for i, raw in enumerate(raw_lines, start=1):
        line = strip_comment(raw)

        # Track display state — only check prose lines
        if ENV_BEGIN_RE.search(line) or DISPLAY_OPEN.match(line.strip()):
            in_display = True
            continue
        if ENV_END_RE.search(line) or DISPLAY_CLOSE.match(line.strip()):
            in_display = False
            continue
        if in_display:
            continue

        # Skip lines that are entirely math or empty
        if not line.strip():
            continue

        for pattern in (_BY_CAP_RE, _BY_PROP_PATTERN):
            for m in pattern.finditer(line):
                matched = m.group()
                # Whitelist check
                if _BY_WHITELIST_RE.match(matched):
                    continue
                snippet = line[max(0, m.start() - 10):m.end() + 30].strip()
                findings.append({
                    'file': file_label,
                    'line': i,
                    'kind': 'by-property',
                    'snippet': snippet[:80],
                })

    return findings


# --------------------------------------------------------------------------
# Comma-splice / comma-as-connective in math sentences
#
# A comma inside math that joins two independent relation-clauses with no
# connecting word ("where", "so", "we have", …) is a comma standing in for a
# word. We substitute the math to grammar-typed English (relations -> the verb
# "equals", arrows -> "maps", symbols -> the noun "x", \text{} -> its prose)
# and flag a comma with a relation-clause on both sides — unless the clauses are
# joined by a coordinating conjunction (X, and Y) or the left side is a fronted
# subordinate clause (For every X, Y), both of which are proper commas.
# --------------------------------------------------------------------------

_ARROWS_RE = re.compile(
    r'\\(?:to|longrightarrow|rightarrow|mapsto|hookrightarrow|'
    r'twoheadrightarrow|longmapsto|xrightarrow)\b')
_RELS_RE = re.compile(
    r'\\(?:le|leq|leqslant|ge|geq|geqslant|ne|neq|in|notin|subseteq|subset|'
    r'supseteq|supset|approx|sim|simeq|equiv|cong|propto|leftrightarrow|iff|mid)\b')

_VERB_MARKERS = {'equals', 'maps'}
_CONJ_WORDS = {'and', 'or', 'but'}
_FRONTERS = {'for', 'if', 'when', 'whenever', 'let', 'suppose', 'given',
             'assume', 'since', 'because', 'where', 'while', 'as'}


def _math_to_grammar_english(math: str) -> str:
    """Substitute math to grammar-typed English for clause-structure checking."""
    s = math
    s = re.sub(r'\\text\{([^{}]*)\}', r' \1 ', s)          # \text{...} -> prose
    s = re.sub(r'\\q(where|for|and)\b', r' \1 ', s)         # \qwhere -> where
    s = _ARROWS_RE.sub(' maps ', s)                         # arrows -> verb
    s = _RELS_RE.sub(' equals ', s)                         # relations -> verb
    s = re.sub(r'(?<![=<>!:])=(?!=)', ' equals ', s)        # = -> verb
    s = re.sub(r'(?<![<>])[<>](?![<>])', ' equals ', s)     # < > -> verb
    s = re.sub(r'\\(?:quad|qquad|,|;|!|:|\s)', ' ', s)      # spacing macros
    s = re.sub(r'\\\\', ' ', s)                             # line break
    s = re.sub(r'\\[a-zA-Z]+\*?', ' ', s)                   # drop other commands
    s = re.sub(r'[^A-Za-z,\. ]+', ' ', s)                   # keep letters/comma/period
    keep = _VERB_MARKERS | {'where', 'for', 'and', 'in', 'or', 'but'}
    out = []
    for tok in re.split(r'(\s+|,)', s):
        if tok.strip() == '' or tok == ',':
            out.append(tok)
        elif tok.lower() in keep:
            out.append(tok.lower())
        elif re.fullmatch(r'[A-Za-z]{3,}', tok):
            out.append(tok)                                 # \text prose word
        else:
            out.append('x')                                 # 1-2 letter symbol -> noun
    s = re.sub(r'\s+', ' ', ''.join(out)).strip()
    if s and s[-1] not in '.!?':
        s += ' .'
    return s


def _is_comma_splice(math: str, nlp) -> bool:
    """True if `math` contains a comma joining two relation-clauses with no word."""
    english = _math_to_grammar_english(math)
    try:
        doc = nlp(english)
    except Exception:
        return False
    for sent in doc.sents:
        toks = [t for t in sent if t.text.strip()]
        first_alpha = next((t for t in toks if t.is_alpha), None)
        fronted = first_alpha is not None and first_alpha.text.lower() in _FRONTERS
        has_cc = any(t.text.lower() in _CONJ_WORDS for t in toks)
        if has_cc or fronted:
            continue
        comma_idxs = [i for i, t in enumerate(toks) if t.text == ',']
        for ci in comma_idxs:
            left_verb = any(t.text.lower() in _VERB_MARKERS for t in toks[:ci])
            right_verb = any(t.text.lower() in _VERB_MARKERS for t in toks[ci + 1:])
            if left_verb and right_verb:
                return True
    return False


def _iter_math_spans(raw_lines):
    """Yield (lineno, math_str) for inline $...$/$$...$$ and display blocks."""
    in_display = False
    display_start = 0
    display_buf = []
    bracket_depth = 0
    for i, raw in enumerate(raw_lines, start=1):
        line = strip_comment(raw)
        if in_display:
            if ENV_END_RE.search(line) or DISPLAY_CLOSE.match(line.strip()):
                bracket_depth = max(0, bracket_depth - 1)
                if ENV_END_RE.search(line) or bracket_depth == 0:
                    in_display = False
                    body = line
                    body = ENV_END_RE.sub(' ', body)
                    body = DISPLAY_CLOSE.sub(' ', body)
                    display_buf.append(body)
                    yield (display_start, ' '.join(display_buf))
                    display_buf = []
                continue
            display_buf.append(line)
            continue
        if ENV_BEGIN_RE.search(line) or DISPLAY_OPEN.match(line.strip()):
            in_display = True
            display_start = i
            bracket_depth = 1
            body = ENV_BEGIN_RE.sub(' ', line)
            body = DISPLAY_OPEN.sub(' ', body)
            display_buf = [body]
            # single-line display closed on same line?
            env_close = ENV_END_RE.search(body)
            bracket_close = DISPLAY_CLOSE_ANY.search(body)
            if env_close or bracket_close:
                in_display = False
                # The display span ends at its first same-line close delimiter.
                # Do not include prose after \] in the math body.
                close = min(
                    (m for m in (env_close, bracket_close) if m is not None),
                    key=lambda m: m.start())
                body = body[:close.start()]
                yield (i, body)
                display_buf = []
            continue
        for m in INLINE_MATH_RE.finditer(line):
            inner = m.group().strip('$')
            yield (i, inner)


def check_comma_splice(raw_lines, file_label, nlp):
    """Detect comma-as-connective inside math spans."""
    findings = []
    for lineno, math in _iter_math_spans(raw_lines):
        if ',' not in math:
            continue
        if _is_comma_splice(math, nlp):
            findings.append({
                'file': file_label,
                'line': lineno,
                'kind': 'comma-splice',
                'snippet': math.strip()[:80],
            })
    return findings


# --------------------------------------------------------------------------
# spaCy pass: check substituted prose for structural grammar violations
# --------------------------------------------------------------------------

def check_grammar_with_spacy(raw_lines, file_label, nlp):
    """
    Build a substituted text, run spaCy on each paragraph, and look for
    grammar violations that the pre-passes don't catch.

    Current rules implemented here:
      - PUNCT (: or ,) immediately before a __DISPLAY__ sentinel →
        colon-before-display / comma-before-display
        (This is a fallback; the pre-pass above should catch most cases.)
    """
    findings = []
    # Build (lineno, text) list
    subst_lines = list(build_substituted_lines(raw_lines))

    # Group into paragraphs (split on blank lines)
    paragraphs = []   # list of [(lineno, text), ...]
    current = []
    for lineno, text in subst_lines:
        if text == '':
            if current:
                paragraphs.append(current)
                current = []
        else:
            current.append((lineno, text))
    if current:
        paragraphs.append(current)

    for para in paragraphs:
        # Join paragraph lines into a single string, tracking token→lineno map
        combined = ' '.join(text for _, text in para)
        # Run spaCy
        try:
            doc = nlp(combined)
        except Exception:
            continue

        # Rule: PUNCT (, or :) before DISPLAY sentinel
        tokens = list(doc)
        for idx, tok in enumerate(tokens):
            if tok.text == '__DISPLAY__' and idx > 0:
                prev = tokens[idx - 1]
                if prev.text in (':', ','):
                    # Find the line number — use the line that contributed __DISPLAY__
                    display_line = next(
                        (ln for ln, t in para if '__DISPLAY__' in t), para[0][0]
                    )
                    # The offending punct is on the line before the display
                    punct_line = display_line - 1
                    kind = 'colon-before-display' if prev.text == ':' else 'comma-before-display'
                    # Build snippet from the combined text around the punct
                    start = max(0, prev.idx - 30)
                    snippet = combined[start:prev.idx + 20].strip()
                    findings.append({
                        'file': file_label,
                        'line': punct_line,
                        'kind': kind,
                        'snippet': snippet[-60:],
                    })

    return findings


# --------------------------------------------------------------------------
# Main lint entry point
# --------------------------------------------------------------------------

def lint_text(text: str, file_label: str = '<text>'):
    nlp = spacy.load('en_core_web_sm')
    raw_lines = text.split('\n')

    findings = []
    findings += check_punct_before_display(raw_lines, file_label)
    findings += check_comma_before_conjunction(raw_lines, file_label)
    findings += check_by_property(raw_lines, file_label)
    findings += check_comma_splice(raw_lines, file_label, nlp)
    # spaCy pass catches anything the pre-passes miss and provides the
    # infrastructure for future grammar rules.
    spacy_findings = check_grammar_with_spacy(raw_lines, file_label, nlp)
    # Deduplicate with pre-pass results (same line + kind)
    pre_keys = {(f['line'], f['kind']) for f in findings}
    for f in spacy_findings:
        if (f['line'], f['kind']) not in pre_keys:
            findings.append(f)

    return findings


def parse_line_range(arg):
    """Parse START:END into (start, end) inclusive. Returns None if not given."""
    if not arg:
        return None
    parts = arg.split(':')
    if len(parts) != 2:
        print(f'bad --lines format: {arg!r} (expected START:END)', file=sys.stderr)
        sys.exit(2)
    return int(parts[0]), int(parts[1])


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Grammar linter for .tex files')
    parser.add_argument('file', help='tex file to lint')
    parser.add_argument('--lines', help='filter to line range START:END (inclusive)')
    args = parser.parse_args()

    with open(args.file, 'r', encoding='utf-8') as fh:
        text = fh.read()
    results = lint_text(text, args.file)

    line_range = parse_line_range(args.lines)
    if line_range:
        start, end = line_range
        results = [r for r in results if start <= r['line'] <= end]

    json.dump(results, sys.stdout)


if __name__ == '__main__':
    main()
