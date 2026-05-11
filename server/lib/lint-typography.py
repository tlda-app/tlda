#!/usr/bin/env python3
"""
Grammar linter for .tex files: non-grammatical commas and colons.

Substitutes math with grammatical placeholders so spaCy can parse prose
containing math as normal English, then uses the dependency tree to flag
violations.

Flags:
  colon-before-display   — colon immediately before a display equation
  comma-before-display   — comma immediately before a display equation
  comma-before-conjunction — comma before \\qwhere/\\qfor/\\qand in display math

Usage:
    python3 lint-typography.py <tex-file>

Outputs JSON to stdout: [{file, line, kind, snippet}, ...]
"""

import json
import re
import sys

import spacy

# Display environment names
_DISPLAY_ENV_NAMES = (
    r'equation\*?|align\*?|gather\*?|multline\*?|'
    r'eqnarray\*?|flalign\*?|alignat\*?|subequations|cases'
)
ENV_BEGIN_RE = re.compile(rf'\\begin\{{({_DISPLAY_ENV_NAMES})\}}')
ENV_END_RE   = re.compile(rf'\\end\{{({_DISPLAY_ENV_NAMES})\}}')
DISPLAY_OPEN_RE  = re.compile(r'^\s*\\\[')
DISPLAY_CLOSE_RE = re.compile(r'^\s*\\\]')

COMMENT_RE = re.compile(r'(?<!\\)%.*$')

INLINE_MATH_RE = [
    re.compile(r'\$\$[^$]*\$\$'),
    re.compile(r'\$[^$\n]*\$'),
    re.compile(r'\\\([^)]*\\\)'),
]

CONJUNCTION_COMMA_RE = re.compile(r',\s*\\q(where|for|and)\b')

# Placeholder that spaCy will tag as a noun (all-caps proper noun heuristic)
DISPLAY_PLACEHOLDER = 'DISPLAYMATH'


def strip_comment(line):
    return COMMENT_RE.sub('', line).rstrip()


def is_display_opener(line):
    s = line.strip()
    return bool(DISPLAY_OPEN_RE.match(s) or ENV_BEGIN_RE.search(s))


def is_display_closer(line):
    s = line.strip()
    return bool(DISPLAY_CLOSE_RE.match(s) or ENV_END_RE.search(s))


def is_blank_or_comment(line):
    s = line.strip()
    return s == '' or s.startswith('%')


def substitute_inline_math(line):
    """Replace inline math and q-macros so the line is parseable English."""
    s = line
    for pat in INLINE_MATH_RE:
        s = pat.sub(' M ', s)
    # Expand q-conjunction macros to their English words
    s = s.replace(r'\qwhere', 'where')
    s = s.replace(r'\qfor', 'for')
    s = s.replace(r'\qand', 'and')
    # Strip common LaTeX wrappers, preserving their text content
    s = re.sub(r'\\(?:emph|textbf|textit|texttt|mathit|mathrm)\{([^}]*)\}', r' \1 ', s)
    s = re.sub(r'\\(?:cite[ptes]?|ref|eqref|label|cref|Cref|autoref|pageref)\{[^}]*\}', ' ', s)
    return s


def linearize(lines):
    """
    Convert TeX source into a list of (orig_line_number, prose_text) pairs
    suitable for spaCy parsing.

    Display environments are collapsed into a single DISPLAYMATH token
    appended to whatever prose line immediately preceded them, preserving
    the comma or colon that may have ended that line.  This lets spaCy
    see "We have, DISPLAYMATH" and parse the punctuation in context.

    Inline math is replaced with "M" (a noun).
    """
    result = []          # list of (1-indexed line number, text)
    pending_line = None  # (line_no, text) of the last non-blank prose line
    in_display = False
    bracket_depth = 0

    for i, raw in enumerate(lines, start=1):
        line = strip_comment(raw)

        if in_display:
            if is_display_closer(line):
                bracket_depth = max(0, bracket_depth - 1)
                if bracket_depth == 0 or ENV_END_RE.search(line):
                    in_display = False
                    # Append placeholder to the prose line that opened the display
                    if pending_line is not None:
                        ln, text = pending_line
                        result.append((ln, text + ' ' + DISPLAY_PLACEHOLDER + '.'))
                        pending_line = None
            # Inside display — skip content
            continue

        if is_blank_or_comment(line):
            if pending_line is not None:
                result.append(pending_line)
                pending_line = None
            continue

        if is_display_opener(line):
            in_display = True
            bracket_depth += 1
            # Don't flush pending_line yet — wait until display closes
            # so we can append DISPLAYMATH to it
            if pending_line is None:
                # Display with no preceding prose line
                pending_line = (i, DISPLAY_PLACEHOLDER + '.')
            # else keep existing pending_line, will get DISPLAYMATH appended on close
            continue

        # Regular prose line
        if pending_line is not None:
            result.append(pending_line)
        subst = substitute_inline_math(line).strip()
        if subst:
            pending_line = (i, subst)
        else:
            pending_line = None

    if pending_line is not None:
        result.append(pending_line)

    return result


def check_punct_before_display(nlp, linearized, file_label):
    """
    Use spaCy to flag colon or comma immediately before a DISPLAYMATH token.
    These are always grammar errors: the equation IS part of the sentence,
    not something introduced by a colon or separated by a comma.
    """
    findings = []
    for line_no, text in linearized:
        if DISPLAY_PLACEHOLDER not in text:
            continue
        doc = nlp(text)
        for tok in doc:
            if tok.text == DISPLAY_PLACEHOLDER:
                # Look at the token immediately before it
                if tok.i > 0:
                    prev = doc[tok.i - 1]
                    if prev.text in (':', ','):
                        kind = ('colon-before-display' if prev.text == ':'
                                else 'comma-before-display')
                        # Build snippet from the original linearized text
                        snippet = text[:text.index(DISPLAY_PLACEHOLDER)].strip()[-60:]
                        findings.append({
                            'file': file_label,
                            'line': line_no,
                            'kind': kind,
                            'snippet': snippet.strip(),
                        })
    return findings


def check_comma_before_conjunction(lines, file_label):
    """
    Inside display math blocks, flag comma before \\qwhere/\\qfor/\\qand.
    These macros are conjunctions — a preceding comma is always a grammar error.
    """
    findings = []
    in_display = False
    bracket_depth = 0

    for i, raw in enumerate(lines, start=1):
        line = strip_comment(raw)

        if not in_display:
            if ENV_BEGIN_RE.search(line):
                in_display = True
                continue
            if DISPLAY_OPEN_RE.match(line.strip()):
                in_display = True
                bracket_depth += 1
                continue
            continue

        if ENV_END_RE.search(line):
            in_display = False
            continue
        if DISPLAY_CLOSE_RE.match(line.strip()):
            bracket_depth = max(0, bracket_depth - 1)
            if bracket_depth == 0:
                in_display = False

        m = CONJUNCTION_COMMA_RE.search(line)
        if m:
            snippet = line[max(0, m.start() - 20):m.start() + 40].strip()
            findings.append({
                'file': file_label,
                'line': i,
                'kind': 'comma-before-conjunction',
                'snippet': snippet,
            })

    return findings


def lint_text(text, file_label='<text>'):
    nlp = spacy.load('en_core_web_sm')
    lines = text.split('\n')
    linearized = linearize(lines)

    findings = []
    findings += check_punct_before_display(nlp, linearized, file_label)
    findings += check_comma_before_conjunction(lines, file_label)
    return findings


def main():
    if len(sys.argv) < 2:
        print('usage: lint-typography.py <tex-file>', file=sys.stderr)
        sys.exit(2)
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        text = f.read()
    findings = lint_text(text, sys.argv[1])
    json.dump(findings, sys.stdout)


if __name__ == '__main__':
    main()
