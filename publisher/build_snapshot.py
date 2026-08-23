import argparse
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import unicodedata
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse


BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
PUBLIC_ID_LENGTH = 22
PUBLIC_ID_MODULUS = len(BASE62) ** PUBLIC_ID_LENGTH
SLUG_RE = re.compile(r"^[a-z0-9-]{1,100}$")
PRODUCT_INPUT_FIELDS = {
    "source_id", "slug", "title", "description", "category", "tags",
    "images", "attributes", "price", "availability_band",
    "lead_time_days", "purchasable",
}
AVAILABILITY_BANDS = {"in_stock", "low", "out_of_stock"}


class PublisherError(ValueError):
    def __init__(self, code, detail=""):
        super().__init__(detail or code)
        self.code = code


def _iso_utc(value):
    if value is None:
        moment = datetime.now(timezone.utc)
    else:
        try:
            moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError as exc:
            raise PublisherError("INVALID_GENERATED_AT") from exc
        if moment.tzinfo is None:
            raise PublisherError("INVALID_GENERATED_AT")
        moment = moment.astimezone(timezone.utc)
    return moment.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _text(value, maximum, required=False):
    if value is None:
        cleaned = ""
    else:
        cleaned = " ".join(str(value).split())
    if required and not cleaned:
        raise PublisherError("MISSING_REQUIRED_FIELD")
    if len(cleaned) > maximum:
        raise PublisherError("VALUE_TOO_LONG")
    return cleaned


def _https_url(value):
    text = _text(value, 2048, required=True)
    try:
        parsed = urlparse(text)
    except ValueError as exc:
        raise PublisherError("INVALID_IMAGE_URL") from exc
    if parsed.scheme != "https" or not parsed.netloc or not parsed.path.strip("/"):
        raise PublisherError("INVALID_IMAGE_URL")
    return text


def opaque_public_id(source_id, key):
    key_bytes = str(key or "").encode("utf-8")
    if len(key_bytes) < 32:
        raise PublisherError("ID_KEY_TOO_SHORT")
    message = f"catalog-product:v1:{source_id}".encode("utf-8")
    number = int.from_bytes(hmac.new(key_bytes, message, hashlib.sha256).digest(), "big")
    number %= PUBLIC_ID_MODULUS
    output = []
    for _ in range(PUBLIC_ID_LENGTH):
        number, remainder = divmod(number, len(BASE62))
        output.append(BASE62[remainder])
    return "".join(reversed(output))


def _slug(value, title, public_id):
    if value:
        candidate = str(value)
        if not SLUG_RE.fullmatch(candidate):
            raise PublisherError("INVALID_SLUG")
        return candidate
    ascii_title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii")
    candidate = re.sub(r"[^a-z0-9]+", "-", ascii_title.lower()).strip("-")[:100]
    return candidate or f"product-{public_id[:12].lower()}"


def _images(value):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 20:
        raise PublisherError("INVALID_IMAGES")
    output = []
    for item in value:
        if not isinstance(item, dict) or set(item) - {"url", "alt"}:
            raise PublisherError("INVALID_IMAGES")
        image = {"url": _https_url(item.get("url"))}
        alt = _text(item.get("alt"), 300)
        if alt:
            image["alt"] = alt
        output.append(image)
    return output


def _tags(value):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 50:
        raise PublisherError("INVALID_TAGS")
    output = []
    for item in value:
        tag = _text(item, 100, required=True)
        if tag not in output:
            output.append(tag)
    return output


def _attributes(value):
    if value is None:
        return {}
    if not isinstance(value, dict) or len(value) > 50:
        raise PublisherError("INVALID_ATTRIBUTES")
    output = {}
    for key, item in value.items():
        name = _text(key, 100, required=True)
        if isinstance(item, bool) or not isinstance(item, (str, int, float)):
            raise PublisherError("INVALID_ATTRIBUTES")
        if isinstance(item, str):
            item = _text(item, 500)
        if isinstance(item, float) and not (float("-inf") < item < float("inf")):
            raise PublisherError("INVALID_ATTRIBUTES")
        output[name] = item
    return output


def _price(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {"amount", "currency", "tier"}:
        raise PublisherError("INVALID_PRICE")
    amount = value.get("amount")
    try:
        numeric_amount = float(amount)
    except (OverflowError, TypeError, ValueError):
        numeric_amount = float("nan")
    if (
        isinstance(amount, bool)
        or not isinstance(amount, (int, float))
        or not math.isfinite(numeric_amount)
        or amount < 0
    ):
        raise PublisherError("INVALID_PRICE")
    currency = _text(value.get("currency"), 3, required=True).upper()
    if not re.fullmatch(r"[A-Z]{3}", currency):
        raise PublisherError("INVALID_PRICE")
    output = {"amount": round(numeric_amount, 2), "currency": currency}
    tier = _text(value.get("tier"), 100)
    if tier:
        output["tier"] = tier
    return output


def normalize_product(value, key, generated_at):
    if not isinstance(value, dict):
        raise PublisherError("INVALID_PRODUCT")
    source_id = _text(value.get("source_id"), 200, required=True)
    public_id = opaque_public_id(source_id, key)
    title = _text(value.get("title"), 300, required=True)
    availability = _text(value.get("availability_band"), 30, required=True)
    if availability not in AVAILABILITY_BANDS:
        raise PublisherError("INVALID_AVAILABILITY")
    product = {
        "public_id": public_id,
        "slug": _slug(value.get("slug"), title, public_id),
        "title": title,
        "availability_band": availability,
        "as_of": generated_at,
        "source": "publisher_cli",
    }
    optional_text = {
        "description": 5000,
        "category": 200,
    }
    for field, maximum in optional_text.items():
        cleaned = _text(value.get(field), maximum)
        if cleaned:
            product[field] = cleaned
    tags = _tags(value.get("tags"))
    if tags:
        product["tags"] = tags
    images = _images(value.get("images"))
    if images:
        product["images"] = images
    attributes = _attributes(value.get("attributes"))
    if attributes:
        product["attributes"] = attributes
    price = _price(value.get("price"))
    if price:
        product["price"] = price
    lead_time = value.get("lead_time_days")
    if lead_time is not None:
        if isinstance(lead_time, bool) or not isinstance(lead_time, int) or lead_time < 0:
            raise PublisherError("INVALID_LEAD_TIME")
        product["lead_time_days"] = lead_time
    purchasable = value.get("purchasable")
    if purchasable is not None and not isinstance(purchasable, bool):
        raise PublisherError("INVALID_PURCHASABLE")
    product["purchasable"] = (
        purchasable if purchasable is not None
        else availability != "out_of_stock" and price is not None
    )
    return source_id, product, len(set(value) - PRODUCT_INPUT_FIELDS)


def _tenant_scopes(value, id_by_source):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise PublisherError("INVALID_TENANTS")
    output = {}
    for tenant_id, scope in value.items():
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", str(tenant_id)):
            raise PublisherError("INVALID_TENANT_ID")
        if not isinstance(scope, dict) or set(scope) - {"source_ids", "price_tier", "allow_full_enumeration"}:
            raise PublisherError("INVALID_TENANT_SCOPE")
        source_ids = scope.get("source_ids")
        if not isinstance(source_ids, list) or any(not isinstance(item, str) for item in source_ids):
            raise PublisherError("INVALID_TENANT_SCOPE")
        try:
            product_ids = sorted({id_by_source[source_id] for source_id in source_ids})
        except KeyError as exc:
            raise PublisherError("UNKNOWN_TENANT_PRODUCT") from exc
        price_tier = _text(scope.get("price_tier"), 100, required=True)
        allow = scope.get("allow_full_enumeration")
        if not isinstance(allow, bool):
            raise PublisherError("INVALID_TENANT_SCOPE")
        output[str(tenant_id)] = {
            "product_ids": product_ids,
            "price_tier": price_tier,
            "allow_full_enumeration": allow,
        }
    return output


def build_snapshot(payload, key, generated_at=None, valid_for_seconds=86400):
    if not isinstance(payload, dict) or set(payload) - {"products", "tenants"}:
        raise PublisherError("INVALID_INPUT")
    products = payload.get("products")
    if not isinstance(products, list) or not products:
        raise PublisherError("INVALID_INPUT")
    if not isinstance(valid_for_seconds, int) or not 60 <= valid_for_seconds <= 604800:
        raise PublisherError("INVALID_VALIDITY_WINDOW")
    generated = _iso_utc(generated_at)
    valid_until = (
        datetime.fromisoformat(generated.replace("Z", "+00:00"))
        + timedelta(seconds=valid_for_seconds)
    ).isoformat().replace("+00:00", "Z")
    normalized = []
    id_by_source = {}
    seen_public_ids = set()
    discarded_fields = 0
    for index, value in enumerate(products):
        try:
            source_id, product, discarded = normalize_product(value, key, generated)
        except PublisherError as exc:
            raise PublisherError(exc.code, f"product index {index}: {exc.code}") from exc
        if source_id in id_by_source or product["public_id"] in seen_public_ids:
            raise PublisherError("DUPLICATE_PRODUCT")
        id_by_source[source_id] = product["public_id"]
        seen_public_ids.add(product["public_id"])
        normalized.append(product)
        discarded_fields += discarded
    normalized.sort(key=lambda item: item["public_id"])
    snapshot = {
        "schema_version": 1,
        "generated_at": generated,
        "valid_until": valid_until,
        "products": normalized,
        "tenant_scopes": _tenant_scopes(payload.get("tenants"), id_by_source),
    }
    serialized = json.dumps(snapshot, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    report = {
        "schema_version": 1,
        "product_count": len(normalized),
        "tenant_count": len(snapshot["tenant_scopes"]),
        "discarded_input_field_count": discarded_fields,
        "generated_at": generated,
        "valid_until": valid_until,
        "snapshot_sha256": hashlib.sha256(serialized.encode("utf-8")).hexdigest(),
    }
    return snapshot, report


def read_payload(source, tenant_config=None):
    path = Path(source)
    if path.suffix.lower() == ".jsonl":
        products = []
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            try:
                products.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise PublisherError("INVALID_JSONL", f"invalid JSON on line {line_number}") from exc
        tenants = {}
    else:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise PublisherError("INVALID_JSON") from exc
        if isinstance(payload, list):
            products, tenants = payload, {}
        elif isinstance(payload, dict):
            products, tenants = payload.get("products"), payload.get("tenants", {})
            if set(payload) - {"products", "tenants"}:
                raise PublisherError("INVALID_INPUT")
        else:
            raise PublisherError("INVALID_INPUT")
    if tenant_config:
        try:
            tenants = json.loads(Path(tenant_config).read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise PublisherError("INVALID_TENANT_CONFIG") from exc
    return {"products": products, "tenants": tenants}


def write_json_atomic(path, value):
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build a governed catalog snapshot without network access.")
    parser.add_argument("--source", required=True, help="JSON or JSONL product input")
    parser.add_argument("--tenant-config", help="Optional JSON tenant scope object")
    parser.add_argument("--output", default="build/published-catalog.json")
    parser.add_argument("--report", default="build/publisher-report.json")
    parser.add_argument("--generated-at", help="Fixed ISO-8601 time for reproducible builds")
    parser.add_argument("--valid-for-seconds", type=int, default=86400)
    parser.add_argument("--id-key-env", default="CATALOG_ID_KEY")
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args(argv)
    try:
        if not args.check_only:
            protected = {Path(args.source).resolve()}
            if args.tenant_config:
                protected.add(Path(args.tenant_config).resolve())
            output = Path(args.output).resolve()
            report = Path(args.report).resolve()
            if output == report or output in protected or report in protected:
                raise PublisherError("INVALID_OUTPUT_PATH")
        key = os.environ.get(args.id_key_env, "")
        payload = read_payload(args.source, args.tenant_config)
        snapshot, report = build_snapshot(payload, key, args.generated_at, args.valid_for_seconds)
        if not args.check_only:
            write_json_atomic(args.output, snapshot)
            write_json_atomic(args.report, report)
        print(json.dumps(report, sort_keys=True))
        return 0
    except (OSError, PublisherError) as exc:
        code = exc.code if isinstance(exc, PublisherError) else "FILE_ERROR"
        print(json.dumps({"error": {"code": code}}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
