import argparse
import json
from pathlib import Path

from product_common import normalize_product, read_products, shopify_product_input


MUTATION = "mutation productSet($input: ProductSetInput!) { productSet(input: $input) { product { id } userErrors { field message } } }"


def build_rows(source):
    return [
        {"query": MUTATION, "variables": {"input": shopify_product_input(normalize_product(product))}}
        for product in read_products(source)
    ]


def main():
    parser = argparse.ArgumentParser(description="Build a file-only Shopify productSet JSONL artifact.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()

    rows = build_rows(args.input)
    output = Path(args.output)
    manifest = Path(args.manifest)
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows), encoding="utf-8")
    manifest.write_text(json.dumps({
        "operation": "productSet",
        "row_count": len(rows),
        "network_calls": False,
        "publish_status": "DRAFT",
    }, indent=2) + "\n", encoding="utf-8")
    print(f"rows={len(rows)} network_calls=false publish_status=DRAFT")


if __name__ == "__main__":
    main()
