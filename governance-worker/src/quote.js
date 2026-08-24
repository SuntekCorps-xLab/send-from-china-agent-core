import { getProductByPublicId } from "./catalog.js";
import { getSnapshotMeta } from "./snapshot.js";

export class QuoteError extends Error {
  constructor(code, status = 400) {
    super("Quote request failed.");
    this.name = "QuoteError";
    this.code = code;
    this.status = status;
  }
}

export function createQuote(value, tenant, now = Date.now()) {
  if (getSnapshotMeta().stale) throw new QuoteError("CATALOG_STALE", 503);
  const publicId = String(value?.public_id || "");
  const quantity = Number(value?.quantity);
  const shipTo = String(value?.ship_to || "").toUpperCase();
  if (!/^[A-Za-z0-9]{22}$/.test(publicId)) throw new QuoteError("INVALID_PUBLIC_ID");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw new QuoteError("INVALID_QUANTITY");
  if (!/^[A-Z]{2}$/.test(shipTo)) throw new QuoteError("INVALID_DESTINATION");
  const product = getProductByPublicId(publicId, tenant);
  if (!product) throw new QuoteError("PRODUCT_NOT_FOUND", 404);
  if (!product.price) throw new QuoteError("PRICE_NOT_AVAILABLE", 409);
  const issuedAt = new Date(now);
  if (!Number.isFinite(issuedAt.getTime())) throw new QuoteError("INVALID_QUOTE_TIME", 500);
  return {
    quote_id: `quote_${crypto.randomUUID()}`,
    quote_kind: "catalog_estimate",
    public_id: product.public_id,
    unit_price: { amount: product.price.amount, currency: product.price.currency },
    quantity,
    ship_to: shipTo,
    availability: product.availability_band,
    shipping_included: false,
    tax_included: false,
    destination_evaluated: false,
    expires_at: new Date(issuedAt.getTime() + 15 * 60 * 1000).toISOString(),
    binding: false,
  };
}
