import argparse
import json
from pathlib import Path

from product_common import normalize_product, read_products


def validate(source):
    normalized = []
    errors = []
    for index, product in enumerate(read_products(source)):
        try:
            normalized.append(normalize_product(product))
        except ValueError as exc:
            errors.append({"index": index, "code": "INVALID_PRODUCT", "message": str(exc)})
    return normalized, errors


def main():
    parser = argparse.ArgumentParser(description="Validate a synthetic product import file.")
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", default="build/products.normalized.json")
    parser.add_argument("--report", default="build/validation-report.json")
    args = parser.parse_args()

    normalized, errors = validate(args.source)
    output = Path(args.output)
    report = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    report.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"products": normalized}, indent=2) + "\n", encoding="utf-8")
    report.write_text(json.dumps({
        "source_count": len(normalized) + len(errors),
        "valid_count": len(normalized),
        "error_count": len(errors),
        "errors": errors,
    }, indent=2) + "\n", encoding="utf-8")
    print(f"validated={len(normalized)} errors={len(errors)}")
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
