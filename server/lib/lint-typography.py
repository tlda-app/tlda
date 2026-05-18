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
    # spaCy pass catches anything the pre-passes miss and provides the
    # infrastructure for future grammar rules.
    spacy_findings = check_grammar_with_spacy(raw_lines, file_label, nlp)
    # Deduplicate with pre-pass results (same line + kind)
    pre_keys = {(f['line'], f['kind']) for f in findings}
    for f in spacy_findings:
        if (f['line'], f['kind']) not in pre_keys:
            findings.append(f)

    return findings


def main():
    if len(sys.argv) < 2:
        print('usage: lint-typography.py <tex-file>', file=sys.stderr)
        sys.exit(2)
    with open(sys.argv[1], 'r', encoding='utf-8') as fh:
        text = fh.read()
    results = lint_text(text, sys.argv[1])
    json.dump(results, sys.stdout)


if __name__ == '__main__':
    main()
