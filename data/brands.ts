/**
 * Seed brands. On first start (empty Brand table) `prisma/seed.ts` writes these into the database together with the demo
 * reference posts in data/demo-references.json. After that, brands are created and edited in the app (Brands tab); this file
 * is not read again, except for the optional `referenceImages` below.
 *
 * Northwind Coffee Roasters is a FICTIONAL demo brand. Every fact, price, handle and URL below is invented for the demo.
 * Replace it with your own brand in the Brands tab (or edit this file before the first start).
 */
export type BrandSeed = {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  websiteUrl: string;
  /**
   * Optional built-in reference images for the image model (direct image URLs only). The first time a brand's assets are listed
   * they are fetched once into the BrandAsset table (lib/references.ts, source "website"). Usually you upload images in the app
   * (Brand assets tab) instead.
   */
  referenceImages?: { url: string; kind: "product" | "packaging" | "logo" | "person" | "mood" | "other"; label: string }[];
  languages: string[];
  platforms: string[];
  pillars: string[];
  audience: string;
  voice: string;
  visual: string;
  offers: string;
  guardrails: string;
  categoryRules?: string;
  forbiddenTerms?: string[];
  claimTerms?: string[];
  claimSensitive?: boolean;
  complianceReview?: boolean;
};

export const BRANDS: BrandSeed[] = [
  {
    slug: "northwind-coffee",
    name: "Northwind Coffee Roasters",
    tagline: "Small-batch coffee, roasted on Tuesdays.",
    websiteUrl: "https://northwind-coffee.example",
    languages: ["en", "de"],
    platforms: ["instagram", "tiktok", "linkedin"],
    pillars: [
      "Behind the roast (how a batch is made)",
      "Brew guides (filter, espresso, cold brew)",
      "Origin stories (the farms we buy from)",
      "Subscription and offers",
      "Café life and community",
    ],
    description:
      "Fictional demo brand. Independent coffee roaster with one café and an online shop. Roasts small batches (12 kg) every Tuesday and ships whole beans or ground coffee in 250 g and 1 kg bags. Buys green coffee from three partner farms (Colombia, Ethiopia, Guatemala). Sells a monthly coffee subscription.",
    audience:
      "Home brewers aged 25 to 45 who own a grinder or want to buy one and care about freshness. Office managers who order coffee for small teams. Café regulars who follow the roaster on Instagram for new single origins.",
    voice:
      "Warm, plain and specific. Short sentences, concrete details (roast date, grind size, water temperature) instead of adjectives. Address the reader as you (English) or du (German). No exclamation marks in hooks, at most one emoji per post.",
    visual:
      "Warm natural light, wooden counter, kraft-paper bags with a navy label, steam and hands in frame. Colours: navy #1f2a44, cream #f4efe6, copper #b87333. Avoid stock-photo baristas and latte-art close-ups without context.",
    offers:
      "250 g bag: 12.90 EUR. 1 kg bag: 44.00 EUR. Monthly subscription: 2 x 250 g for 23.90 EUR per month, cancel anytime. Free shipping from 35 EUR. Shop: northwind-coffee.example/shop. Instagram and TikTok: @northwind.coffee.demo. CTAs: 'Order this week's roast', 'Save this brew guide', 'Link in bio'.",
    guardrails:
      "Never make health claims about coffee (no 'boosts metabolism', 'burns fat', 'healthy'). Never invent awards, scores, certifications or customer numbers. Do not call the coffee 'organic' or 'fair trade' (not certified). Only the prices listed in OFFERS; no invented discounts.",
    categoryRules: "Category: DTC food and beverage, small business. Default register: you (English) / du (German).",
    forbiddenTerms: ["organic", "fair trade", "award-winning"],
    claimTerms: ["boosts", "burns fat", "healthy"],
    claimSensitive: false,
    complianceReview: true,
  },
];
