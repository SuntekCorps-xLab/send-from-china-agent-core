import { PUBLIC_ATTRIBUTE_NAMES } from "../sdk/src/search-contract-v2.js";

const PUBLIC_ATTRIBUTES = new Set(PUBLIC_ATTRIBUTE_NAMES);
const FIELD_NAMES = Object.freeze({
  material: ["material", "materials"],
  color: ["color", "colors", "colour"],
  model: ["model", "compatible_models", "compatibility"],
});
const TEXT_CONDITIONS = new Set(["material", "color", "model", "must_have", "exclude"]);
const UNKNOWN_REASON = "Public catalog data could not verify this condition; unverified candidates were omitted.";
const UNSUPPORTED_REASON = "The deterministic catalog checks cannot execute this condition or operand.";
const CURRENCY_REASON = "A numeric price constraint cannot compare catalog amounts in different currencies.";
const VARIANT_REASON = "Published option choices do not prove a matching variant combination or its price.";
const NEGATORS = new Set(["no", "not", "without", "non", "exclude", "excludes", "excluding"]);
const SCOPE_RESETS = new Set(["and", "but", "with", "contains", "plus"]);

function normalize(value) {
  return String(value).normalize("NFKC").toLowerCase().replace(/[\u2010-\u2015]/gu, "-")
    .replace(/n['\u2019]t\b/gu, " not").trim();
}

function tokens(value) {
  return normalize(value).match(/[\p{L}\p{N}]+/gu) || [];
}

function publicText(product) {
  const values = [product.title, product.description, product.category];
  if (Array.isArray(product.tags)) values.push(...product.tags);
  for (const [name, value] of Object.entries(product.attributes || {})) {
    if (PUBLIC_ATTRIBUTES.has(name) && ["string", "number", "boolean"].includes(typeof value)) {
      values.push(String(value));
    }
  }
  return values.filter((value) => typeof value === "string" && value.trim());
}

function attributeText(product, names) {
  return names.map((name) => product.attributes?.[name])
    .filter((value) => typeof value === "string" && value.trim());
}

function operand(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 80) return null;
  let phrase = normalize(value);
  // Operators need a structured contract; never guess their Boolean meaning.
  if (/[<>=*|]/u.test(phrase) || /\b(?:or|and)\b/u.test(phrase)) return null;
  let negated = false;
  const prefix = /^(?:no|not|without|excluding|exclude|non)\s+(.+)$/u.exec(phrase);
  const suffix = /^(.+?)[ -]free$/u.exec(phrase);
  if (prefix) {
    negated = true;
    phrase = prefix[1];
  } else if (suffix) {
    negated = true;
    phrase = suffix[1];
  }
  const terms = tokens(phrase);
  if (!terms.length || terms.some((term) => NEGATORS.has(term))) return null;
  return Object.freeze({ phrase, terms, negated });
}

function phrasePresence(texts, terms) {
  let ambiguous = false;
  for (const text of texts) {
    for (const sentence of normalize(text).split(/[.;!?\n]/u)) {
      const sentenceTokens = tokens(sentence);
      for (let index = 0; index <= sentenceTokens.length - terms.length; index += 1) {
        if (!terms.every((term, offset) => term === sentenceTokens[index + offset])) continue;
        let prefix = sentenceTokens.slice(Math.max(0, index - 4), index);
        const reset = prefix.findLastIndex((word, offset) => SCOPE_RESETS.has(word)
          && !(word === "with" && ["compatible", "made", "constructed"].includes(prefix[offset - 1]))
          && !(word === "contains" && NEGATORS.has(prefix[offset - 1])));
        prefix = prefix.slice(reset + 1);
        const suffix = sentenceTokens[index + terms.length];
        const negations = prefix.filter((word) => NEGATORS.has(word)).length
          + Number(suffix === "free" || suffix === "excluded");
        if (negations > 1 || (negations && prefix.includes("only"))) ambiguous = true;
        else if (!negations) return true;
      }
    }
  }
  return ambiguous ? null : false;
}

function modelPresence(texts, term) {
  // Model identity is exact within a published model list. A shorter model name
  // must not match a different numbered model or a Pro/Max variant.
  return texts.some((text) => normalize(text).split(/[,;|/\n]/u)
    .some((entry) => entry.trim() === term.phrase));
}

function compile(condition, mixedCurrencies) {
  if (!condition || condition.source !== "explicit" || condition.scope !== "product"
    || condition.hardness !== "hard") return { condition, reason: UNSUPPORTED_REASON };
  const { name, value } = condition;
  if (name === "price_min" || name === "price_max") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { condition, reason: UNSUPPORTED_REASON };
    }
    if (mixedCurrencies) return { condition, reason: CURRENCY_REASON };
    return { condition, evaluate(product) {
      const price = product.price;
      if (!price || typeof price.amount !== "number" || !Number.isFinite(price.amount)
        || price.amount < 0 || !/^[A-Z]{3}$/u.test(price.currency || "")) return null;
      return name === "price_min" ? price.amount >= value : price.amount <= value;
    } };
  }
  if (!TEXT_CONDITIONS.has(name)) return { condition, reason: UNSUPPORTED_REASON };
  const values = Array.isArray(value) ? value : [value];
  const terms = values.map(operand);
  if (!values.length || values.length > 20 || terms.some((term) => term === null)) {
    return { condition, reason: UNSUPPORTED_REASON };
  }
  return { condition, evaluate(product) {
    const texts = FIELD_NAMES[name] ? attributeText(product, FIELD_NAMES[name]) : publicText(product);
    if (!texts.length) return null;
    const outcomes = terms.map((term) => {
      const present = name === "model" ? modelPresence(texts, term) : phrasePresence(texts, term.terms);
      if (present === null) return null;
      const positive = term.negated ? !present : present;
      return name === "exclude" ? !positive : positive;
    });
    if (outcomes.includes(false)) return false;
    return outcomes.includes(null) ? null : true;
  } };
}

/**
 * Check only projected public catalog fields. Conditions and array operands are
 * conjunctive. Unknown candidates are omitted with an explicit relaxation;
 * callers must preserve degraded status even when the upstream page is final.
 */
export function applyShopifyHardConstraints(products, request, options = {}) {
  if (!Array.isArray(products) || !request || !Array.isArray(request.hard_constraints)) {
    throw new TypeError("Deterministic Shopify checks require public products and hard constraints");
  }
  const currencies = new Set(products.map((product) => product.price?.currency)
    .filter((currency) => typeof currency === "string" && /^[A-Z]{3}$/u.test(currency)));
  const checks = request.hard_constraints.map((condition) => compile(condition, currencies.size > 1));
  const activeChecks = checks.filter((check) => check.evaluate);
  const priceChecks = activeChecks.filter((check) => ["price_min", "price_max"].includes(check.condition.name));
  const textChecks = activeChecks.filter((check) => TEXT_CONDITIONS.has(check.condition.name)
    && check.condition.name !== "exclude");
  const textRequirements = textChecks.reduce((count, check) => count
    + (Array.isArray(check.condition.value) ? check.condition.value.length : 1), 0);
  const hasVariantChoices = typeof options.hasVariantChoices === "function"
    ? options.hasVariantChoices
    : (product) => Object.entries(product.attributes || {}).some(([name, value]) => (
      PUBLIC_ATTRIBUTES.has(name) && typeof value === "string" && /[,;|/\n]/u.test(value)
    ));
  const relaxations = [];
  function relax(check, reason) {
    const condition = check.condition?.name;
    if (typeof condition !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(condition)) return;
    if (!relaxations.some((entry) => entry.condition === condition && entry.reason === reason)) {
      // Never copy request text, product data, or private fields into diagnostics.
      relaxations.push(Object.freeze({ condition, reason }));
    }
  }
  for (const check of checks) if (check.reason) relax(check, check.reason);
  const kept = [];
  let unknown = checks.some((check) => check.reason);
  for (const product of products) {
    const outcomes = checks.map((check) => check.evaluate ? check.evaluate(product) : true);
    // A proven failure remains excluded even if another field is unavailable.
    if (outcomes.includes(false)) continue;
    if (outcomes.includes(null)) {
      unknown = true;
      outcomes.forEach((result, index) => { if (result === null) relax(checks[index], UNKNOWN_REASON); });
      continue;
    }
    if (hasVariantChoices(product)
      && ((priceChecks.length && textChecks.length) || textRequirements > 1)) {
      unknown = true;
      for (const check of [...priceChecks, ...textChecks]) relax(check, VARIANT_REASON);
      continue;
    }
    kept.push(product);
  }
  return Object.freeze({
    products: Object.freeze(kept),
    relaxations: Object.freeze(relaxations),
    degraded: unknown,
  });
}
