import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { AMAZON_IN_ORIGIN } from "../config/env";
import { extractAsin, isValidAsin } from "./normalizers";
import type { ParsedProductEntry, ProductResultPage } from "./types";

const SEARCH_CARD = '[data-component-type="s-search-result"][data-asin]';
const BESTSELLER_CARD = "div.p13n-sc-uncoverable-faceout";
const GRID_CARD = "div.zg-grid-general-faceout";
const SEARCH_NEXT = "a.s-pagination-next[href]";
const SEARCH_NEXT_DISABLED = "span.s-pagination-next";
const BESTSELLER_NEXT = "li.a-last a[href]";

const TITLE_SELECTORS = [
  "h2 a span",
  "h2 span",
  '[data-cy="title-recipe"] h2 span',
  "span.a-size-medium.a-color-base.a-text-normal",
  "span.a-size-base-plus.a-color-base.a-text-normal",
  "div[class*='p13n-sc-css-line-clamp']",
  "div[class*='p13n-sc-truncate']",
];

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function absoluteUrl(href: string | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href, AMAZON_IN_ORIGIN).toString();
  } catch {
    return null;
  }
}

function titleFor($: cheerio.CheerioAPI, node: cheerio.Cheerio<Element>): string | null {
  const heading = node
    .find("h2")
    .toArray()
    .map((el) => collapse($(el).text()))
    .filter((text) => text.length > 0)
    .join(" ");
  if (heading.length > 0) return heading;

  for (const selector of TITLE_SELECTORS) {
    const text = collapse(node.find(selector).first().text());
    if (text.length > 0) return text;
  }
  const alt = collapse(node.find("img[alt]").first().attr("alt") ?? "");
  return alt.length > 0 ? alt : null;
}

function nextPageUrl($: cheerio.CheerioAPI): string | null {
  const searchNext = $(SEARCH_NEXT).first();
  if (searchNext.length > 0) {
    const url = absoluteUrl(searchNext.attr("href"));
    if (url) return url;
  }
  if ($(SEARCH_NEXT_DISABLED).length > 0) return null;

  const bestsellerNext = $(BESTSELLER_NEXT).first();
  if (bestsellerNext.length > 0) {
    const url = absoluteUrl(bestsellerNext.attr("href"));
    if (url) return url;
  }

  return null;
}

export function buildDiscoveryUrl(brandName: string, categoryName: string): string {
  const query = [brandName, categoryName]
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0)
    .join(" ");
  return `${AMAZON_IN_ORIGIN}/s?k=${encodeURIComponent(query)}`;
}

export function parseDiscoveryPage(html: string): ProductResultPage {
  const $ = cheerio.load(html);
  const products: ParsedProductEntry[] = [];
  const seen = new Set<string>();

  const addEntry = (node: cheerio.Cheerio<Element>, asinHint: string | null, sponsored: boolean) => {
    const href = node.find('a[href*="/dp/"]').first().attr("href");
    const asin =
      asinHint && isValidAsin(asinHint) ? asinHint : extractAsin(href ?? "");
    if (!asin || seen.has(asin)) return;
    seen.add(asin);

    products.push({
      asin,
      url: `${AMAZON_IN_ORIGIN}/dp/${asin}/`,
      title: titleFor($, node),
      sponsored,
    });
  };

  $(SEARCH_CARD).each((_, el) => {
    const node = $(el) as cheerio.Cheerio<Element>;
    const asin = (node.attr("data-asin") ?? "").toUpperCase();
    const sponsored = node.find(".s-sponsored-label-text, a[href*='/sspa/']").length > 0;
    addEntry(node, asin, sponsored);
  });

  for (const selector of [BESTSELLER_CARD, GRID_CARD]) {
    $(selector).each((_, el) => {
      const node = $(el) as cheerio.Cheerio<Element>;
      const id = (node.attr("id") ?? "").toUpperCase();
      const asin = isValidAsin(id) ? id : null;
      addEntry(node, asin, false);
    });
  }

  if (products.length === 0) {
    $('a[href*="/dp/"]').each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const asin = extractAsin(href);
      if (!asin || seen.has(asin)) return;
      seen.add(asin);
      products.push({
        asin,
        url: `${AMAZON_IN_ORIGIN}/dp/${asin}/`,
        title: collapse($(el).text()) || null,
        sponsored: false,
      });
    });
  }

  return { products, nextPageUrl: nextPageUrl($) };
}
