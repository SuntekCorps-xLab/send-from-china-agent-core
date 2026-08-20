import json
from pathlib import Path
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

from build_shopify_jsonl import build_rows  # noqa: E402
from product_common import normalize_product  # noqa: E402
from validate_import import validate  # noqa: E402


class PipelineTest(unittest.TestCase):
    def product(self):
        return {
            "source_id": "synthetic-001",
            "title": "Synthetic Desk Organizer",
            "description_html": "<p>Synthetic description.</p>",
            "images": [{"url": "https://images.example.com/product.jpg"}],
            "variants": [{"sku": "DEMO-001", "price": "19.9"}],
        }

    def test_normalizes_price_and_requires_https_images(self):
        normalized = normalize_product(self.product())
        self.assertEqual(normalized["variants"][0]["price"], "19.90")
        invalid = self.product()
        invalid["images"] = [{"url": "http://images.example.com/product.jpg"}]
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            normalize_product(invalid)

    def test_rejects_duplicate_skus_and_non_positive_price(self):
        invalid = self.product()
        invalid["variants"] = [
            {"sku": "DUP", "price": "1.00"},
            {"sku": "DUP", "price": "0"},
        ]
        with self.assertRaisesRegex(ValueError, "unique"):
            normalize_product(invalid)

    def test_validator_is_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.json"
            path.write_text(json.dumps({"products": [self.product(), {"title": "bad"}]}), encoding="utf-8")
            valid, errors = validate(path)
            self.assertEqual(len(valid), 1)
            self.assertEqual(errors[0]["code"], "INVALID_PRODUCT")

    def test_builder_is_file_only_and_draft(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.json"
            path.write_text(json.dumps({"products": [self.product()]}), encoding="utf-8")
            rows = build_rows(path)
            self.assertEqual(len(rows), 1)
            product = rows[0]["variables"]["input"]
            self.assertEqual(product["status"], "DRAFT")
            self.assertEqual(product["variants"][0]["inventoryPolicy"], "DENY")
            self.assertNotIn("endpoint", rows[0])


if __name__ == "__main__":
    unittest.main()
