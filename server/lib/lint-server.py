#!/usr/bin/env python3
"""Warm lint server: load spaCy ONCE, answer newline-delimited JSON lint requests.

Keeps the model resident so per-request latency is ~milliseconds instead of the
~1-2s cold model load a fresh `python3 lint-typography.py` pays every call. Reuses
the exact detection in lint-typography.py — one implementation, both surfaces.

Protocol (stdin -> stdout, one JSON object per line):
  request:  {"id": <any>, "text": "<message or tex source>", "file": "<label>"}
  response: {"id": <same>, "findings": [{"file","line","kind","snippet"}, ...]}
On startup it emits {"ready": true} once the model is loaded.
"""
import importlib.util
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    'lint_typography', os.path.join(_HERE, 'lint-typography.py'))
_lt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_lt)  # defines check_comma_splice etc.; main() is guarded

import spacy  # noqa: E402

_nlp = spacy.load('en_core_web_sm')


def _handle(req):
    text = req.get('text', '') or ''
    raw_lines = text.split('\n')
    label = req.get('file', '<chat>')
    findings = _lt.check_comma_splice(raw_lines, label, _nlp)
    return {'id': req.get('id'), 'findings': findings}


def main():
    sys.stdout.write(json.dumps({'ready': True}) + '\n')
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:  # noqa: BLE001
            sys.stdout.write(json.dumps({'error': f'bad json: {e}'}) + '\n')
            sys.stdout.flush()
            continue
        try:
            resp = _handle(req)
        except Exception as e:  # noqa: BLE001
            resp = {'id': req.get('id'), 'error': str(e), 'findings': []}
        sys.stdout.write(json.dumps(resp) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
