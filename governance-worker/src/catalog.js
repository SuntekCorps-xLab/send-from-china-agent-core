const PRODUCTS = Object.freeze([
  Object.freeze({
    id: "demo-desk-organizer",
    handle: "demo-desk-organizer",
    title: "Modular Desk Organizer",
    description: "A synthetic demonstration product for organizing pens and small accessories.",
    category: "Office",
    tags: Object.freeze(["desk", "organizer", "office", "storage"]),
  }),
  Object.freeze({
    id: "demo-garden-trowel",
    handle: "demo-garden-trowel",
    title: "Compact Garden Trowel",
    description: "A synthetic demonstration product for balcony and container gardening.",
    category: "Garden",
    tags: Object.freeze(["garden", "tool", "trowel", "balcony"]),
  }),
  Object.freeze({
    id: "demo-building-blocks",
    handle: "demo-building-blocks",
    title: "Wooden Building Blocks",
    description: "A synthetic demonstration product for open-ended construction play.",
    category: "Toys",
    tags: Object.freeze(["toy", "blocks", "wooden", "building"]),
  }),
  Object.freeze({
    id: "demo-travel-pouch",
    handle: "demo-travel-pouch",
    title: "Travel Cable Pouch",
    description: "A synthetic demonstration product for keeping charging cables together.",
    category: "Travel",
    tags: Object.freeze(["travel", "cable", "pouch", "organizer"]),
  }),
]);

function publicProduct(product) {
  return {
    ...product,
    tags: [...product.tags],
    source: "synthetic_demo",
    availability: "demo_only",
    purchasable: false,
  };
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
}

function score(product, terms) {
  if (!terms.length) return 1;
  const title = product.title.toLowerCase();
  const category = product.category.toLowerCase();
  const tags = product.tags.join(" ").toLowerCase();
  const description = product.description.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (title.includes(term)) total += 8;
    if (tags.includes(term)) total += 5;
    if (category.includes(term)) total += 3;
    if (description.includes(term)) total += 1;
  }
  return total;
}

function encodeCursor(offset) {
  return btoa(String(offset)).replace(/=+$/g, "");
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const decoded = Number.parseInt(atob(cursor), 10);
    return Number.isSafeInteger(decoded) && decoded >= 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function listCatalog({ limit = 20, cursor = "" } = {}) {
  const offset = decodeCursor(cursor);
  if (offset === null) return { error: "INVALID_CURSOR" };
  const items = PRODUCTS.slice(offset, offset + limit).map(publicProduct);
  const nextOffset = offset + items.length;
  return {
    items,
    next_cursor: nextOffset < PRODUCTS.length ? encodeCursor(nextOffset) : null,
    total: PRODUCTS.length,
  };
}

export function searchCatalog(query, { limit = 20, cursor = "" } = {}) {
  const offset = decodeCursor(cursor);
  if (offset === null) return { error: "INVALID_CURSOR" };
  const terms = tokenize(query);
  const ranked = PRODUCTS
    .map((product) => ({ product, score: score(product, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.product.id.localeCompare(right.product.id));
  const items = ranked.slice(offset, offset + limit).map((entry) => publicProduct(entry.product));
  const nextOffset = offset + items.length;
  return {
    items,
    next_cursor: nextOffset < ranked.length ? encodeCursor(nextOffset) : null,
    total: ranked.length,
  };
}

export function getProduct(handle) {
  const product = PRODUCTS.find((entry) => entry.handle === handle);
  return product ? publicProduct(product) : null;
}
