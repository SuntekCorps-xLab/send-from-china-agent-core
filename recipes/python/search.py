"""Zero-account Agent Core synthetic search recipe."""

from __future__ import annotations

import json
import os
import sys
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


def _safe_base_url(value: str) -> str:
    parsed = urlparse(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {".".join(("127", "0", "0", "1")), "localhost", "::1"}
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("The synthetic recipe accepts only a loopback HTTP sandbox URL.")
    return value.rstrip("/")


def search(query: str = "desk organizer", base_url: str | None = None) -> dict:
    """Return a bounded result from the local synthetic sandbox."""
    base = _safe_base_url(base_url or os.environ.get("AGENT_CORE_SANDBOX_URL", "http://127.0.0.1:8790"))
    url = f"{base}/sandbox/api/search?{urlencode({'q': query, 'limit': 3})}"
    request = Request(url, headers={"Accept": "application/json"}, method="GET")
    with urlopen(request, timeout=10) as response:  # nosec B310: URL is validated loopback-only above
        return json.load(response)


if __name__ == "__main__":
    result = search(sys.argv[1] if len(sys.argv) > 1 else "desk organizer")
    print(json.dumps(result, indent=2))
