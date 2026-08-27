#!/usr/bin/env python3
"""Rewrite a master homework .qmd into a student handout.

This course's own tooling, not tlda's. It exists so the classroom setup path can
be exercised end to end against a course that shares nothing with any other:
every solution div becomes an empty answer box, tagged from the exercise above it
so a marking UI can group answers.

Usage: make-handout.py <master.qmd> <handout.qmd>
"""
import re
import sys
from pathlib import Path

FENCE = re.compile(r'^:{3,}\s*(.*)$')


def classes_and_id(attrs):
    ids = re.findall(r'#([\w-]+)', attrs)
    return set(re.findall(r'\.([\w-]+)', attrs)), ids[0] if ids else None


def main(master, handout):
    out, exercise_id, depth = [], None, 0
    for line in Path(master).read_text().splitlines():
        fence = FENCE.match(line)
        if depth:
            if fence and not fence.group(1):
                depth = 0
            continue
        if fence and fence.group(1):
            classes, div_id = classes_and_id(fence.group(1))
            if 'callout-exercise' in classes:
                exercise_id = div_id
            if 'callout-solution' in classes:
                depth = 1
                tag = f'#ans-{exercise_id[4:]} ' if exercise_id and exercise_id.startswith('exr-') else ''
                out.append(f'::: {{{tag}.callout-answer}}')
                out.append('')
                out.append(':::')
                continue
        out.append(line)
    Path(handout).write_text('\n'.join(out) + '\n')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
