import html
import json
from pathlib import Path
import re
from urllib.parse import urlparse


PRICE_RE = re.compile(r"^[0-9]+(?:\.[0-9]{1,2})?$")


def read_products(path):
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    products = payload.get("products") if isinstance(payload, dict) else payload
    if not isinstance(products, list):
        raise ValueError("source must be a product list or an object with a products list")
    return products


def is_https_url(value):
    try:
        parsed = urlparse(str(value))
    except ValueError:
        return False
    return parsed.scheme == "https" and bool(parsed.netloc) and bool(parsed.path.strip("/"))


def clean_text(value, maximum):
    return " ".join(str(value or "").split())[:maximum]


def normalize_product(value):
    if not isinstance(value, dict):
        raise ValueError("product must be an object")
    source_id = clean_text(value.get("source_id"), 100)
    title = clean_text(value.get("title"), 255)
    description = str(value.get("description_html") or "").strip()[:20000]
    if not source_id:
        raise ValueError("source_id is required")
    if len(title) < 3:
        raise ValueError("title must contain at least 3 characters")
    if not description:
        raise ValueError("description_html is required")

    images = []
    for item in value.get("images") or []:
        url = clean_text(item.get("url") if isinstance(item, dict) else "", 2048)
        if not is_https_url(url):
            raise ValueError("every image must use a valid HTTPS URL with a path")
        images.append({"url": url})
    if not images:
        raise ValueError("at least one image is required")

    variants = []
    seen_skus = set()
    for item in value.get("variants") or []:
        if not isinstance(item, dict):
            raise ValueError("variant must be an object")
        sku = clean_text(item.get("sku"), 100)
        price = clean_text(item.get("price"), 32)
        if not sku or sku in seen_skus:
            raise ValueError("variant SKUs must be non-empty and unique")
        if not PRICE_RE.fullmatch(price) or float(price) <= 0:
            raise ValueError("variant price must be a positive decimal string")
        seen_skus.add(sku)
        variants.append({"sku": sku, "price": f"{float(price):.2f}"})
    if not variants:
        raise ValueError("at least one variant is required")

    return {
        "source_id": source_id,
        "title": title,
        "description_html": description,
        "images": images,
        "variants": variants,
    }


def shopify_product_input(product):
    return {
        "title": product["title"],
        "descriptionHtml": product["description_html"],
        "status": "DRAFT",
        "files": [
            {"originalSource": image["url"], "contentType": "IMAGE"}
            for image in product["images"]
        ],
        "variants": [
            {
                "price": variant["price"],
                "sku": variant["sku"],
                "inventoryPolicy": "DENY",
            }
            for variant in product["variants"]
        ],
        "metafields": [
            {
                "namespace": "world_products",
                "key": "source_id",
                "type": "single_line_text_field",
                "value": product["source_id"],
            }
        ],
    }


def safe_preview(value):
    return html.escape(str(value), quote=True)
