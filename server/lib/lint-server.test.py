#!/usr/bin/env python3
"""Persistence regression for lint-server.py.

A valid-but-non-object NDJSON frame (e.g. `5`) must be rejected without exiting
the resident server. Before the fix, both the handler and its except path called
req.get on a non-dict, so one bad frame killed the process.

Run:  ~/.config/tlda/lint-venv/bin/python server/lib/lint-server.test.py
Exits non-zero on failure. Spawns the server (pays the one-time spaCy load).
"""
import json
import os
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVER = os.path.join(_HERE, 'lint-server.py')
_failures = []


def check(name, cond):
    print(('  ok  ' if cond else '  FAIL ') + name)
    if not cond:
        _failures.append(name)


proc = subprocess.Popen(
    [sys.executable, _SERVER],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)


def send(obj_line):
    proc.stdin.write(obj_line + '\n')
    proc.stdin.flush()


def readline():
    return json.loads(proc.stdout.readline().strip())


try:
    # startup handshake
    ready = readline()
    check('server emits ready', ready.get('ready') is True)

    # bad frame: valid JSON, not an object — must be rejected, not fatal
    send('5')
    r_bad = readline()
    check('non-object frame gets an error response', 'error' in r_bad)

    # server must STILL be alive and answer a valid request afterward
    send(json.dumps({'id': 7, 'text': r'$p = \Pr(A), d = \E[Y]$', 'file': 't.tex'}))
    r_ok = readline()
    check('server survives the bad frame and answers next request',
          r_ok.get('id') == 7)
    check('valid request after bad frame still detects the splice',
          any(f.get('kind') == 'comma-splice' for f in r_ok.get('findings', [])))

    # a second bad frame (empty array) also must not kill it
    send('[]')
    r_bad2 = readline()
    check('array frame also rejected without exit', 'error' in r_bad2)
    check('process still running after two bad frames', proc.poll() is None)
finally:
    try:
        proc.stdin.close()
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

if _failures:
    print(f'\n{len(_failures)} FAILED: {_failures}')
    sys.exit(1)
print('\nall lint-server persistence tests passed')
