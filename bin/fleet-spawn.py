#!/usr/bin/env python3
"""Compatibility executable for the documented fleet spawn command.

The agent launch implementation lives behind `tlda agent wake`.  This file keeps
the clean-shell `fleet-spawn.py` executable contract at the PATH boundary without
duplicating spawn logic.
"""

import os
import sys


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] in {"-h", "--help"}:
        print("Usage: fleet-spawn.py [spawn args]")
        print("Delegates to: tlda agent wake [spawn args]")
        return
    os.execvp("tlda", ["tlda", "agent", "wake", *sys.argv[1:]])


if __name__ == "__main__":
    main()
