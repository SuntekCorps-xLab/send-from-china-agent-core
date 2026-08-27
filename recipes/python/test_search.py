"""Tests for the dependency-free Python recipe."""

from __future__ import annotations

import io
import json
import unittest
from unittest.mock import patch

import search


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class SearchRecipeTests(unittest.TestCase):
    def test_builds_a_bounded_loopback_request(self):
        body = json.dumps({"mode": "synthetic_local_sandbox", "purchasable": False, "items": []}).encode()
        with patch("search.urlopen", return_value=_Response(body)) as request:
            result = search.search("desk organizer", "http://localhost:9000")
        url = request.call_args.args[0].full_url
        self.assertIn("/sandbox/api/search?", url)
        self.assertIn("limit=3", url)
        self.assertEqual(result["mode"], "synthetic_local_sandbox")

    def test_rejects_non_loopback_urls(self):
        with self.assertRaises(ValueError):
            search.search("desk", "https://example.invalid")


if __name__ == "__main__":
    unittest.main()
