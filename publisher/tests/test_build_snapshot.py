import json
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from build_snapshot import (  # noqa: E402
    PublisherError,
    build_snapshot,
    main,
    opaque_public_id,
    read_payload,
)


KEY = "test-only-catalog-id-key-32-characters-long"
GENERATED_AT = "2026-08-23T12:00:00Z"


class PublisherTest(unittest.TestCase):
    def product(self, source_id="desk-001"):
        return {
            "source_id": source_id,
            "title": "Modular Desk Organizer",
            "description": "Stackable trays for a compact workspace.",
            "category": "Office",
            "tags": ["desk", "organizer"],
            "images": [{"url": "https://images.example.com/catalog/desk.jpg", "alt": "Desk organizer"}],
            "attributes": {"material": "bamboo", "width_cm": 24},
            "price": {"amount": 24.9, "currency": "usd", "tier": "tier_a"},
            "availability_band": "in_stock",
            "lead_time_days": 5,
        }

    def payload(self):
        return {
            "products": [self.product()],
            "tenants": {
                "tenant_alpha": {
                    "source_ids": ["desk-001"],
                    "price_tier": "tier_a",
                    "allow_full_enumeration": False,
                }
            },
        }

    def test_public_ids_are_stable_opaque_base62_values(self):
        first = opaque_public_id("desk-001", KEY)
        second = opaque_public_id("desk-001", KEY)
        self.assertEqual(first, second)
        self.assertRegex(first, r"^[A-Za-z0-9]{22}$")
        self.assertNotIn("desk", first.lower())

    def test_key_is_required_and_must_be_long_enough(self):
        with self.assertRaisesRegex(PublisherError, "ID_KEY_TOO_SHORT"):
            opaque_public_id("desk-001", "short")

    def test_snapshot_is_deterministic_and_drops_unknown_input_fields(self):
        payload = self.payload()
        payload["products"][0]["operator_note"] = "must not leave the publisher"
        first, report = build_snapshot(payload, KEY, GENERATED_AT)
        second, _ = build_snapshot(payload, KEY, GENERATED_AT)
        self.assertEqual(first, second)
        encoded = json.dumps(first)
        self.assertNotIn("source_id", encoded)
        self.assertNotIn("operator_note", encoded)
        self.assertNotIn("must not leave", encoded)
        self.assertEqual(report["discarded_input_field_count"], 1)

    def test_sensitive_scalar_attributes_never_enter_snapshot_or_report(self):
        payload = self.payload()
        payload["products"][0]["attributes"].update({
            "supplier_url": "https://supplier.invalid/item",
            "Cost Price": "1.25",
            "api-key": "not-a-real-key",
            "source_id": "local-row-42",
        })
        snapshot, report = build_snapshot(payload, KEY, GENERATED_AT)
        encoded = json.dumps({"snapshot": snapshot, "report": report})
        for forbidden in ["supplier.invalid", "Cost Price", "api-key", "local-row-42"]:
            self.assertNotIn(forbidden, encoded)
        self.assertEqual(report["discarded_input_field_count"], 4)

    def test_positive_attribute_policy_and_sensitive_values_apply_before_publish(self):
        payload = self.payload()
        github_token = "gh" + "p_abcdefghijklmnop"
        private_key_marker = "-----BEGIN " + "PRIVATE " + "KEY-----"
        loopback = ".".join(["127", "0", "0", "1"])
        documentation_host = ".".join(["192", "0", "2", "10"])
        payload["products"][0]["attributes"].update({
            "compatibility": "Public model family",
            "certification": "basic aluminum",
            "dimensions": "https://" + documentation_host + "/public/specification",
            "voltage": "https://www.example.com/public/specification",
            "accessToken": "hidden",
            "clientSecret": "hidden",
            "customerEmail": "hidden@example.invalid",
            "supplierId": "hidden",
            "actionUrl": "https://checkout.invalid",
            "model": github_token,
            "features": private_key_marker,
            "power": "http://" + loopback + "/private",
        })
        snapshot, report = build_snapshot(payload, KEY, GENERATED_AT)
        attributes = snapshot["products"][0]["attributes"]
        self.assertEqual(attributes, {
            "material": "bamboo",
            "width_cm": 24,
            "compatibility": "Public model family",
            "certification": "basic aluminum",
            "dimensions": "https://" + documentation_host + "/public/specification",
            "voltage": "https://www.example.com/public/specification",
        })
        self.assertEqual(report["discarded_input_field_count"], 8)

    def test_tenant_source_references_become_public_ids(self):
        snapshot, _ = build_snapshot(self.payload(), KEY, GENERATED_AT)
        product_id = snapshot["products"][0]["public_id"]
        self.assertEqual(snapshot["tenant_scopes"]["tenant_alpha"]["product_ids"], [product_id])

    def test_unknown_tenant_product_fails_closed(self):
        payload = self.payload()
        payload["tenants"]["tenant_alpha"]["source_ids"] = ["missing"]
        with self.assertRaisesRegex(PublisherError, "UNKNOWN_TENANT_PRODUCT"):
            build_snapshot(payload, KEY, GENERATED_AT)

    def test_invalid_image_and_nested_attribute_fail_closed(self):
        payload = self.payload()
        payload["products"][0]["images"] = [{"url": "http://images.example.com/catalog/desk.jpg"}]
        with self.assertRaisesRegex(PublisherError, "INVALID_IMAGE_URL"):
            build_snapshot(payload, KEY, GENERATED_AT)
        payload = self.payload()
        payload["products"][0]["attributes"] = {"dimensions": {"width": 24}}
        with self.assertRaisesRegex(PublisherError, "INVALID_ATTRIBUTES"):
            build_snapshot(payload, KEY, GENERATED_AT)

    def test_url_policy_rejects_credentials_provenance_and_non_public_networks(self):
        unsafe_urls = [
            "https://shop.example/product#access_token=secretvalue123",
            "https://shop.example/product#accesstoken=secretvalue123",
            "https://shop.example/product?x-api-key=secretvalue123",
            "https://shop.example/product#authorization=Basic%20YWJjZGVmZ2hpams=.",
            "https://shop.example/product#authorization=Basic%20dXNlcjpwYXNzd29yZA==:",
            "https://catalog.office.lan/product",
            "https://catalog.office.corp/product",
            "https://supplierportal.example/product",
            "https://shop.example/sourcereceipt/1",
            "https://router.localdomain/product",
            "https://router.home.arpa/product",
            "https://[fec0::1]/product",
            "https://[ff00::1]/product",
        ]
        for url in unsafe_urls:
            with self.subTest(url=url, surface="image"):
                payload = self.payload()
                payload["products"][0]["images"] = [{"url": url}]
                with self.assertRaisesRegex(PublisherError, "INVALID_IMAGE_URL"):
                    build_snapshot(payload, KEY, GENERATED_AT)
            with self.subTest(url=url, surface="attribute"):
                payload = self.payload()
                payload["products"][0]["attributes"]["material"] = url
                snapshot, _ = build_snapshot(payload, KEY, GENERATED_AT)
                self.assertNotIn("material", snapshot["products"][0]["attributes"])

        public_url = "https://www.example.com/products/item?variant=1#details"
        payload = self.payload()
        payload["products"][0]["images"] = [{"url": public_url, "alt": "Public product"}]
        payload["products"][0]["attributes"]["voltage"] = public_url
        snapshot, _ = build_snapshot(payload, KEY, GENERATED_AT)
        self.assertEqual(snapshot["products"][0]["images"][0]["url"], public_url)
        self.assertEqual(snapshot["products"][0]["attributes"]["voltage"], public_url)

    def test_non_finite_price_fails_closed(self):
        payload = self.payload()
        payload["products"][0]["price"]["amount"] = float("inf")
        with self.assertRaisesRegex(PublisherError, "INVALID_PRICE"):
            build_snapshot(payload, KEY, GENERATED_AT)

    def test_jsonl_input_accepts_separate_tenant_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "products.jsonl"
            tenants = root / "tenants.json"
            source.write_text(json.dumps(self.product()) + "\n", encoding="utf-8")
            tenants.write_text(json.dumps(self.payload()["tenants"]), encoding="utf-8")
            payload = read_payload(source, tenants)
            snapshot, _ = build_snapshot(payload, KEY, GENERATED_AT)
            self.assertEqual(len(snapshot["products"]), 1)
            self.assertEqual(len(snapshot["tenant_scopes"]), 1)

    def test_cli_writes_snapshot_and_report_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.json"
            output = root / "snapshot.json"
            report = root / "report.json"
            source.write_text(json.dumps(self.payload()), encoding="utf-8")
            previous = os.environ.get("CATALOG_ID_KEY")
            os.environ["CATALOG_ID_KEY"] = KEY
            try:
                code = main([
                    "--source", str(source), "--output", str(output),
                    "--report", str(report), "--generated-at", GENERATED_AT,
                ])
            finally:
                if previous is None:
                    os.environ.pop("CATALOG_ID_KEY", None)
                else:
                    os.environ["CATALOG_ID_KEY"] = previous
            self.assertEqual(code, 0)
            self.assertTrue(output.exists())
            self.assertTrue(report.exists())
            self.assertRegex(json.loads(output.read_text())["products"][0]["public_id"], r"^[A-Za-z0-9]{22}$")
            report_value = json.loads(report.read_text())
            self.assertEqual(report_value["snapshot_sha256"], hashlib.sha256(output.read_bytes()).hexdigest())

    def test_cli_will_not_overwrite_its_input(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.json"
            original = json.dumps(self.payload())
            source.write_text(original, encoding="utf-8")
            previous = os.environ.get("CATALOG_ID_KEY")
            os.environ["CATALOG_ID_KEY"] = KEY
            try:
                code = main(["--source", str(source), "--output", str(source)])
            finally:
                if previous is None:
                    os.environ.pop("CATALOG_ID_KEY", None)
                else:
                    os.environ["CATALOG_ID_KEY"] = previous
            self.assertEqual(code, 1)
            self.assertEqual(source.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
