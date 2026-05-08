#!/usr/bin/env python3
"""
Passive-voice detector for .tex files using spaCy dependency parsing.

Reads a TeX file, strips math environments and inline math, runs spaCy on
each prose line, and reports passive-voice findings via dependency parsing
(auxpass / nsubjpass relations).

Usage:
    python3 lint-passive.py <tex-file>

Outputs JSON to stdout: a list of {file, line, snippet, kind} objects.
"""

import json
import re
import sys

import spacy

# Math environment names — content between \begin{...} ... \end{...} is skipped.
ENV_BLOCK = re.compile(
    r"^\s*\\(?:begin|end)\{(?:equation\*?|align\*?|gather\*?|multline\*?|"
    r"displaymath|eqnarray\*?|array)\}"
)

INLINE_MATH_PATTERNS = [
    re.compile(r"\$\$[^$]*\$\$"),
    re.compile(r"\\\[[^\]]*\\\]"),
    re.compile(r"\$[^$\n]*\$"),
    re.compile(r"\\\([^)]*\\\)"),
]

CITE_PATTERNS = [
    re.compile(r"\\(cite[ptes]?|ref|eqref|pageref|cref|Cref|autoref|label)\{[^}]*\}"),
]


def strip_math_and_refs(line: str) -> str:
    """Replace inline math with placeholder 'M', drop cite/ref args."""
    s = line
    for pat in INLINE_MATH_PATTERNS:
        s = pat.sub(" M ", s)
    for pat in CITE_PATTERNS:
        s = pat.sub(" ", s)
    # Strip simple emph/textbf/textit wrappers but keep their text
    s = re.sub(r"\\(emph|textbf|textit|texttt|mathrm|mathit)\{([^}]*)\}", r" \2 ", s)
    return s


# Verbs that are commonly used as state-of-being predicates in math prose
# when no explicit agent is given. "X is bounded" / "X is satisfied" /
# "X is well-defined" usually mean the property holds, not that someone
# performed an action. We only flag these when there's an explicit agent
# ("by Y"), where the agentive reading is unambiguous.
STATIVE_OK_VERBS = {
    "bounded", "satisfied", "defined", "well-defined", "specified",
    "known", "fixed", "named", "labeled", "labelled", "called",
    "needed", "required", "guaranteed", "ensured", "established",
    "true", "false", "unique", "finite", "infinite", "non-empty",
}


def has_agent(verb_token):
    """Return True if the verb has an explicit `by AGENT` child (agentive passive)."""
    for child in verb_token.children:
        if child.dep_ == "agent":
            return True
        # spaCy sometimes uses "prep" with text "by" rather than "agent"
        if child.dep_ == "prep" and child.text.lower() == "by":
            return True
    return False


def lint_text(text: str, file_label: str = "<text>"):
    """Run passive-voice detection line by line."""
    nlp = spacy.load("en_core_web_sm")
    findings = []
    in_math_env = False
    for i, line in enumerate(text.split("\n"), start=1):
        if not in_math_env and ENV_BLOCK.search(line) and "\\begin" in line:
            in_math_env = True
            continue
        if in_math_env:
            if "\\end" in line and ENV_BLOCK.search(line):
                in_math_env = False
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("%"):
            continue
        prose = strip_math_and_refs(line)
        if not prose.strip():
            continue
        doc = nlp(prose)
        # Iterate tokens; flag passive auxiliaries with their verb.
        seen_verbs = set()
        for tok in doc:
            if tok.dep_ == "auxpass":
                verb = tok.head
                if verb.i in seen_verbs:
                    continue
                seen_verbs.add(verb.i)
                # Skip stative-OK verbs unless they have an explicit agent.
                # "X is bounded" → skip. "X is bounded by C" → flag.
                verb_lemma = verb.lemma_.lower()
                verb_text = verb.text.lower()
                if (verb_lemma in STATIVE_OK_VERBS or verb_text in STATIVE_OK_VERBS) \
                        and not has_agent(verb):
                    continue
                # Build a small snippet around the verb
                start = max(0, verb.i - 2)
                end = min(len(doc), verb.i + 3)
                snippet = " ".join(t.text for t in doc[start:end])
                findings.append(
                    {
                        "file": file_label,
                        "line": i,
                        "kind": "passive",
                        "verb": verb.text,
                        "aux": tok.text,
                        "snippet": snippet[:80].strip(),
                    }
                )
    return findings


def main():
    if len(sys.argv) < 2:
        print("usage: lint-passive.py <tex-file>", file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    findings = lint_text(text, path)
    json.dump(findings, sys.stdout)


if __name__ == "__main__":
    main()
