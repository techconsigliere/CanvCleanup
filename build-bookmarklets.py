#!/usr/bin/env python3
"""Encode each bookmarklet source to a drag-safe javascript: URL."""
from pathlib import Path
from urllib.parse import quote
import sys
ROOT = Path(__file__).parent
TOOLS = {"teacher/filecleanup_src.js": "teacher/filecleanup.bookmarklet.txt"}
# & is NOT safe: inside an HTML href it becomes an entity the browser decodes
# on drag, which would corrupt the code. %26 survives the drag intact.
SAFE = "!$*+,-./:;=?@_~"
def main() -> int:
    for src, out in TOOLS.items():
        source = ROOT / src
        if not source.exists():
            print(f"Missing {src}", file=sys.stderr); return 1
        url = "javascript:" + quote(source.read_text(encoding="utf-8"), safe=SAFE)
        for bad in ('"', "<", ">", " ", "#", "\n"):
            if bad in url:
                print(f"{out} would contain {bad!r}", file=sys.stderr); return 1
        (ROOT / out).write_text(url + "\n", encoding="utf-8")
        print(f"wrote {out} ({len(url)/1024:.0f} KB)")
    return 0
if __name__ == "__main__":
    raise SystemExit(main())
