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
        loopback_host = ".".join(("127", "0", "0", "1"))
        unsafe_urls = [
            "https://shop.example/product#access_token=secretvalue123",
            "https://shop.example/product#accesstoken=secretvalue123",
            "https://shop.example/product?x-api-key=secretvalue123",
            "https://shop.example/product?token=secretvalue123",
            "https://shop.example/product#authorization=Basic%20YWJjZGVmZ2hpams=.",
            "https://shop.example/product#authorization=Basic%20dXNlcjpwYXNzd29yZA==:",
            "https://catalog.office.lan/product",
            "https://catalog.office.corp/product",
            "https://supplierportal.example/product",
            "https://shop.example/sourcereceipt/1",
            "https://shop.example/%252573ourceReceipt/1",
            "https://shop.example/sourcereceiptv2/1",
            "https://supplierportalv2.example/product",
            "https://shop.example/sourcereceipts/1",
            "https://suppliersportal.example/product",
            "https://source.example/product",
            "https://vendorportal.example/product",
            f"https://shop.example/proxy?url=http%3A%2F%2F{loopback_host}%2Fprivate",
            "https://shop.example/proxy?url=https%3A%2F%2Frouter.lan%2Fprivate",
            "https://shop.example/%ZZ/%73ourceReceipt/1",
            "https://127.1/product",
            "https://2130706433/product",
            "https://0x7f000001/product",
            "https://0177.0.0.1/product",
            "https://0x0a000001/product",
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

        for url in [
            "https://shop.example/products/secret-compartment",
            "https://shop.example/products/token-ring",
            "https://shop.example/products/password-journal",
            "https://shop.example/products/session-chair",
            "https://shop.example/products/secret",
            "https://shop.example/products/token",
            "https://shop.example/search?q=secret-compartment",
        ]:
            with self.subTest(url=url, surface="ordinary-commerce-url"):
                payload = self.payload()
                payload["products"][0]["images"] = [{"url": url, "alt": "Public product"}]
                snapshot, _ = build_snapshot(payload, KEY, GENERATED_AT)
                self.assertEqual(snapshot["products"][0]["images"][0]["url"], url)

    def test_every_public_text_surface_rejects_sensitive_values(self):
        loopback_host = ".".join(("127", "0", "0", "1"))
        unsafe_values = [
            "Bearer s3cr3t",
            "Basic dXNlcjpwYXNz",
            "Basic dXNlcjo+",
            "Basic Og==",
            "owner@example.com",
            f"See http://{loopback_host}/private",
            "meta/accessToken=secretvalue123",
            "meta:accessToken=secretvalue123",
            "meta.accessToken=secretvalue123",
            "meta-accessToken=secretvalue123",
            "meta(accessToken=secretvalue123)",
            "meta,accessToken=secretvalue123",
            "{accessToken:secretvalue123}",
            "api.key=secretvalue123",
            "x api key=secretvalue123",
            "token secretvalue123",
            "%252561ccessToken%25253Dsecretvalue123",
            "%ZZ&%61ccessToken%3Dsecretvalue123",
            "sourceReceipt=receipt123",
            "supplierPortal=internal123",
        ]
        for value in unsafe_values:
            mutations = {
                "title": lambda product: product.update({"title": value}),
                "description": lambda product: product.update({"description": value}),
                "category": lambda product: product.update({"category": value}),
                "tag": lambda product: product.update({"tags": [value]}),
                "image_alt": lambda product: product.update({
                    "images": [{"url": "https://www.example.com/images/product.jpg", "alt": value}]
                }),
                "price_tier": lambda product: product["price"].update({"tier": value}),
            }
            for surface, mutate in mutations.items():
                with self.subTest(value=value, surface=surface):
                    payload = self.payload()
                    mutate(payload["products"][0])
                    with self.assertRaisesRegex(PublisherError, "SENSITIVE_PUBLIC_VALUE"):
                        build_snapshot(payload, KEY, GENERATED_AT)
            with self.subTest(value=value, surface="attribute"):
                payload = self.payload()
                payload["products"][0]["attributes"]["material"] = value
                snapshot, _ = build_snapshot(payload, KEY, GENERATED_AT)
                self.assertNotIn("material", snapshot["products"][0]["attributes"])

        payload = self.payload()
        payload["products"][0]["attributes"]["compatibility"] = "Basic QWx1bWludW0="
        snapshot, _ = build_snapshot(payload, KEY, GENERATED_AT)
        self.assertEqual(
            snapshot["products"][0]["attributes"]["compatibility"],
            "Basic QWx1bWludW0=",
        )

        payload = self.payload()
        product = payload["products"][0]
        product.update({
            "title": "Session chair with secret compartment",
            "description": "Token ring motif and password journal cover",
            "category": "Source code learning cards",
            "tags": ["open-source", "supplier-friendly"],
            "images": [{
                "url": "https://www.example.com/images/product.jpg",
                "alt": "Basic QWx1bWludW0= aluminum finish",
            }],
        })
        product["price"]["tier"] = "secret compartment edition"
        product["attributes"]["compatibility"] = "keyboard session stand"
        snapshot, _ = build_snapshot(payload, KEY, GENERATED_AT)
        self.assertEqual(
            snapshot["products"][0]["title"],
            "Session chair with secret compartment",
        )
        self.assertEqual(
            snapshot["products"][0]["attributes"]["compatibility"],
            "keyboard session stand",
        )

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
