#!/usr/bin/env python3
"""Regression tests for lint-typography.py.

Run:  ~/.config/tlda/lint-venv/bin/python server/lib/lint-typography.test.py
Exits non-zero on failure. Pure-regex tests (no spaCy needed for the span logic).
"""
import importlib.util
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    'lint_typography', os.path.join(_here, 'lint-typography.py'))
lt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lt)

_failures = []


def check(name, cond):
    print(('  ok  ' if cond else '  FAIL ') + name)
    if not cond:
        _failures.append(name)


def spans(lines):
    return list(lt._iter_math_spans(lines))


# --- A1 regression: one-line display \[ ... \] with \] at END of line ---
# The anchored DISPLAY_CLOSE only matched \] at line start; after the leading
# \[ is stripped the \] is at the end, so the same-line close was missed and the
# whole span was dropped. It must now be yielded as a single span on its line.
one = spans([r'\[ p = \Pr(A), d = \E[Y] \]'])
check('one-line display yields exactly one span', len(one) == 1)
check('one-line display span is on line 1', one and one[0][0] == 1)
check('one-line display body keeps the comma content',
      one and 'p =' in one[0][1] and ', d =' in one[0][1])
check('one-line display body strips the closing \\]',
      one and '\\]' not in one[0][1])

# Trailing text after the close on the same line must not swallow the span.
one2 = spans([r'\[ a = b \] and then prose'])
check('one-line display with trailing prose still yields one span', len(one2) == 1)

# --- no-regression: multi-line display (\] on its own line) still works ---
multi = spans([r'\[', r'  p = \Pr(A), d = \E[Y]', r'\]'])
check('multi-line display yields one span', len(multi) == 1)
check('multi-line display starts at the open line (1)', multi and multi[0][0] == 1)
check('multi-line display body keeps the content',
      multi and 'p =' in multi[0][1])

# --- no-regression: inline math still detected ---
inl = spans([r'text $x^2$ more $y$ end'])
check('inline math yields two spans', len(inl) == 2)

if _failures:
    print(f'\n{len(_failures)} FAILED: {_failures}')
    sys.exit(1)
print('\nall lint-typography span tests passed')
