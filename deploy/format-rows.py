#!/usr/bin/env python3
"""Turns wrangler's JSON envelope into a table worth reading.

Kept as its own file rather than embedded in the shell script: a Python heredoc
inside a bash pipeline needs three levels of quoting and breaks the moment
anyone edits it.
"""

import json
import sys


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit("could not parse the query result")

    blocks = payload if isinstance(payload, list) else [payload]
    rows = []
    for block in blocks:
        if isinstance(block, dict):
            rows.extend(block.get("results") or [])

    if not rows:
        print("No scans recorded yet.")
        return

    columns = list(rows[0].keys())
    widths = {
        column: max(
            len(column),
            max(len(str(row.get(column, ""))) for row in rows),
        )
        for column in columns
    }

    header = "  ".join(column.upper().ljust(widths[column]) for column in columns)
    print(header)
    print("-" * len(header))
    for row in rows:
        print(
            "  ".join(
                str(row.get(column, "")).ljust(widths[column]) for column in columns
            )
        )
    print()
    print(f"{len(rows)} row{'' if len(rows) == 1 else 's'}")


if __name__ == "__main__":
    main()
