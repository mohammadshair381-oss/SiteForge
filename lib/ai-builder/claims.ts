/**
 * Unsupported-claim check for generated store text (pure; no I/O).
 *
 * Generated text must not state facts the store's own data does not contain:
 * prices, discounts, statistics, years, ratings and reviews, awards,
 * guarantees, certifications, materials or delivery promises. Each phrase of
 * that kind is allowed only when the same fact appears in `facts` (the
 * owner's own words: business details, product data, policies, the request).
 *
 * This is a deliberately strict heuristic: it can flag a harmless phrase, but
 * it errs towards asking the owner rather than publishing an invented fact.
 */

const CLAIM_PATTERNS: RegExp[] = [
  // Money and percentages: "$50", "₹499", "20%", "20 percent", "50 USD".
  /(?:[$€£₹]\s?\d[\d,.]*)|(?:\d[\d,.]*\s?(?:%|percent\b|usd\b|inr\b|eur\b|gbp\b|rs\.?(?=\s|$)))/gi,
  // Years and "since/established" statements.
  /\b(?:since|est\.?|established|founded)\s+(?:in\s+)?\d{4}\b|\b(?:19|20)\d{2}\b/gi,
  // Counts: "10,000+ customers", "500 happy", "1000s of".
  /\b\d[\d,.]*\s*\+?\s*(?:k\b|thousands?\b|millions?\b|customers?\b|clients?\b|orders?\b|reviews?\b|products?\b|years?\b|stores?\b|countries\b|happy\b|satisfied\b|items?\b|styles?\b|brands?\b)/gi,
  // Ratings and reviews.
  /\b\d(?:\.\d)?\s*(?:-|\s)?\s*stars?\b|★|\b(?:rated|rating|ratings|reviews?|reviewed|testimonials?)\b/gi,
  // Rankings, awards, sales claims.
  /#\s?1\b|\bnumber\s+one\b|\b(?:best[-\s]?sell(?:ing|er|ers)|award[-\s]?winning|awards?|top[-\s]?rated|most\s+popular|bestsellers?)\b/gi,
  // Guarantees, warranties, certifications.
  /\b(?:guarantee[ds]?|warrant(?:y|ies|ied)|certified|certification|accredited|approved\s+by|clinically|dermatologist|lab[-\s]?tested)\b/gi,
  // Materials and production claims.
  /\b(?:organic|handmade|hand[-\s]?made|hand[-\s]?crafted|eco[-\s]?friendly|sustainable|vegan|cruelty[-\s]?free|recycled|natural|genuine\s+leather|100\s*%\s*\w+)\b/gi,
  // Delivery and service promises.
  /\b(?:free\s+(?:shipping|delivery|returns?)|same[-\s]?day|next[-\s]?day|express\s+delivery|24\s*\/\s*7|lifetime|money[-\s]?back)\b/gi,
];

/** What each pattern above is about, in the same order. */
const CLAIM_ADVICE: readonly string[] = [
  "Prices and discounts come from your products: set them there, or tell the assistant the real figure.",
  "Add the year to your business description if it is true.",
  "Add the real figure to your business description if it is true.",
  "Ratings and reviews only ever come from approved reviews of real orders.",
  "Add it to your business description if it is true.",
  "Add it to your returns policy or business description if it is true.",
  "Add it to your product details or business description if it is true.",
  "Set it in your delivery settings or shipping policy if it is true.",
];

const BEST_SELLER = /best[-\s]?sell/gi;

const matches = (pattern: RegExp, phrase: string) => {
  pattern.lastIndex = 0;
  const found = pattern.test(phrase);
  pattern.lastIndex = 0;
  return found;
};

/**
 * Prices, ratings, reviews and best sellers have a real source in the store (products, approved reviews,
 * paid orders), so an owner's one-click confirmation must not stand in for it.
 */
export function claimNeedsRealData(phrase: string): boolean {
  return matches(CLAIM_PATTERNS[0], phrase) || matches(CLAIM_PATTERNS[3], phrase) || matches(BEST_SELLER, phrase);
}

/** What to do about one refused phrase, for the owner. */
export function claimAdvice(phrase: string): string {
  if (matches(BEST_SELLER, phrase)) return "Best sellers only ever come from real paid orders, and your store fills them in itself.";
  // Ratings first: "500 reviews" is a claim about reviews, not just a number.
  if (matches(CLAIM_PATTERNS[3], phrase)) return CLAIM_ADVICE[3];
  for (let index = 0; index < CLAIM_PATTERNS.length; index += 1) {
    if (matches(CLAIM_PATTERNS[index], phrase)) return CLAIM_ADVICE[index];
  }
  return "Add it to your business information if it is true.";
}

/** The advice for several phrases, each said once. */
export function explainClaims(flagged: readonly string[]): string {
  return [...new Set(flagged.slice(0, 3).map(claimAdvice))].join(" ");
}

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").replace(/[‐-―]/g, "-").trim();

/** Numbers inside a phrase ("10,000+" -> "10000"), for matching against the facts. */
const numbersIn = (value: string) => (value.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,]/g, "").replace(/\.$/, ""));

/**
 * Phrases in `texts` that state a fact `facts` does not support (unique, in
 * order of appearance). Empty when everything is supported.
 */
export function findUnsupportedClaims(texts: readonly string[], facts: string): string[] {
  const known = normalize(facts);
  const knownNumbers = new Set(numbersIn(known));
  const flagged: string[] = [];
  for (const original of texts) {
    for (const pattern of CLAIM_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of original.matchAll(pattern)) {
        const phrase = match[0].trim();
        if (!phrase) continue;
        const norm = normalize(phrase);
        const numbers = numbersIn(norm);
        // A claim with numbers is supported when every number in it appears in
        // the facts (a price, a year, a threshold); a word claim when the facts
        // contain the same words.
        const supported = numbers.length > 0 ? numbers.every((n) => knownNumbers.has(n)) : known.includes(norm);
        if (!supported && !flagged.some((f) => normalize(f) === norm)) flagged.push(phrase);
      }
    }
  }
  return flagged;
}
