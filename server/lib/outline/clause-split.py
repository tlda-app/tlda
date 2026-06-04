#!/usr/bin/env python3
"""
Clause segmentation for math prose, using spaCy dependency parsing.

Punctuation splitting is not clause segmentation. And masking math as an opaque
blob wrecks the parse exactly where the clauses are. Instead we *verbalize* the
math relations into how they're spoken — variables/expressions become noun
tokens, relations become verbs — so spaCy sees real clauses:

    $a^-_i = \\sqrt{w_i}|h_i|$        ->  "q equals q"          (noun verb noun)
    $a \\le b \\le c$                 ->  "q is at most q is at most q"

Then we split on real clause boundaries from the dependency parse and map the
offsets back to the original text. We never split *inside* an inline $...$ span
(that would break the LaTeX); a boundary landing inside a span snaps to the
span start.

Usage: python3 clause-split.py <textfile>   ->  JSON list of [start,end] offsets.
"""

import json
import re
import sys

import spacy

_NLP = None


def nlp():
    global _NLP
    if _NLP is None:
        _NLP = spacy.load("en_core_web_sm")
    return _NLP


# Relation symbols/macros → spoken verb phrase. Order matters (longest first).
RELATIONS = [
    (r"\\leq?", " is at most "),
    (r"\\geq?", " is at least "),
    (r"\\neq", " is not "),
    (r"\\in\b", " is in "),
    (r"\\notin\b", " is not in "),
    (r"\\subseteq", " is contained in "),
    (r"\\subset", " is contained in "),
    (r"\\equiv", " is equivalent to "),
    (r"\\approx", " is approximately "),
    (r"\\propto", " is proportional to "),
    (r"\\to", " goes to "),
    (r"\\sim", " is like "),
    (r"=", " equals "),
    (r"<", " is less than "),
    (r">", " is greater than "),
]
_REL_RE = re.compile("|".join("(?:%s)" % p for p, _ in RELATIONS))
_REL_LOOKUP = [(re.compile(p), w) for p, w in RELATIONS]
_MATH = re.compile(r"\$[^$]*\$|\\\([^)]*\\\)")


def verbalize_span(content: str) -> str:
    """Turn one inline-math span's content into spoken words: operands→'q', relations→verbs."""
    out = []
    pos = 0
    for m in _REL_RE.finditer(content):
        operand = content[pos:m.start()].strip()
        if operand:
            out.append("q")
        word = next(w for r, w in _REL_LOOKUP if r.fullmatch(m.group()))
        out.append(word.strip())
        pos = m.end()
    tail = content[pos:].strip()
    if tail or not out:
        out.append("q")
    return " ".join(out)


def build_verbalized(text: str):
    """Return (verbalized_text, segments) where segments map verbalized↔original.

    segments: list of (vstart, vend, ostart, oend, is_math). Prose segments map
    1:1; math segments map the whole verbalized rendering to the $...$ span.
    """
    parts = []
    segs = []
    v = 0
    o = 0
    for m in _MATH.finditer(text):
        # prose before this math span (1:1)
        if m.start() > o:
            prose = text[o:m.start()]
            parts.append(prose)
            segs.append((v, v + len(prose), o, m.start(), False))
            v += len(prose)
        inner = m.group()
        inner = inner[1:-1] if inner.startswith("$") else inner[2:-2]
        verb = " " + verbalize_span(inner) + " "
        parts.append(verb)
        segs.append((v, v + len(verb), m.start(), m.end(), True))
        v += len(verb)
        o = m.end()
    if o < len(text):
        prose = text[o:]
        parts.append(prose)
        segs.append((v, v + len(prose), o, len(text), False))
    return "".join(parts), segs


def vpos_to_opos(vpos, segs):
    """Map a verbalized char offset back to an original offset."""
    for vstart, vend, ostart, oend, is_math in segs:
        if vstart <= vpos < vend:
            if is_math:
                return ostart  # don't split inside a math span — snap to its start
            return ostart + (vpos - vstart)
    return segs[-1][3] if segs else 0


_CLAUSE_DEPS = {"advcl", "relcl", "ccomp", "parataxis", "csubj", "acl"}


def split(text: str):
    vtext, segs = build_verbalized(text)
    doc = nlp()(vtext)
    vstarts = set()
    for sent in doc.sents:
        vstarts.add(sent.start_char)
    for tok in doc:
        head_clause = tok.dep_ in _CLAUSE_DEPS and tok.pos_ in ("VERB", "AUX")
        conj_verb = tok.dep_ == "conj" and tok.pos_ in ("VERB", "AUX")
        if head_clause or conj_verb:
            left = min((t.idx for t in tok.subtree), default=tok.idx)
            vstarts.add(left)
        elif tok.dep_ == "mark":
            vstarts.add(tok.idx)

    # map to original offsets
    ostarts = {vpos_to_opos(v, segs) for v in vstarts}

    # Always split at a semicolon (outside math) — it's a near-certain clause
    # boundary, and SpaCy can miss it when the ';' sits against a math span.
    for m in re.finditer(r";", text):
        p = m.start()
        in_math = any(is_math and ostart <= p < oend
                      for (_, _, ostart, oend, is_math) in segs)
        if not in_math:
            ostarts.add(p + 1)

    ostarts = sorted(ostarts)
    if not ostarts or ostarts[0] != 0:
        ostarts = [0] + ostarts

    spans = []
    for i, s in enumerate(ostarts):
        e = ostarts[i + 1] if i + 1 < len(ostarts) else len(text)
        a, b = s, e
        while a < b and text[a].isspace():
            a += 1
        while b > a and text[b - 1].isspace():
            b -= 1
        # require a real clause: at least one verb/relation in the verbalized form
        if b > a:
            spans.append([a, b])

    # Group clauses by sentence so the outline can nest clause-under-sentence.
    # Sentence boundaries come from the same parse; map them back to original.
    sent_ostarts = sorted({vpos_to_opos(s.start_char, segs) for s in doc.sents})

    def sent_index(pos):
        idx = 0
        for i, so in enumerate(sent_ostarts):
            if so <= pos:
                idx = i
            else:
                break
        return idx

    groups = {}
    for sp in spans:
        groups.setdefault(sent_index(sp[0]), []).append(sp)
    return [groups[k] for k in sorted(groups)]


def main():
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        text = f.read()
    # Output: list of sentences, each a list of [start,end] clause spans.
    json.dump(split(text), sys.stdout)


if __name__ == "__main__":
    main()
