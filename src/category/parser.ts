import * as cheerio from "cheerio";
import type { ParseResult } from "./types";
import { isCategoryUrl, normalizeCategoryUrl } from "./normalizer";

const NAV_TREE_ROOT_UL = 'ul[class*="_p13n-zg-nav-tree-all_style_zg-browse-root"]';
const BROWSE_ITEM_LI = 'li[class*="_p13n-zg-nav-tree-all_style_zg-browse-item"]';
const BROWSE_UP_MARKER = "_p13n-zg-nav-tree-all_style_zg-browse-up";
const ANCESTOR_REF_MARKERS = ["zg_bs_unv_"];

function isAncestorLink(href: string, liClass: string, text: string): boolean {
  if (liClass.includes(BROWSE_UP_MARKER)) return true;
  if (ANCESTOR_REF_MARKERS.some((marker) => href.includes(marker))) return true;
  if (text.startsWith("\u2039")) return true;
  return false;
}

export function parseCategoryPage(html: string, currentUrl: string): ParseResult {
  const $ = cheerio.load(html);

  let currentNormalized: string;
  try {
    currentNormalized = normalizeCategoryUrl(currentUrl);
  } catch {
    throw new TypeError(`currentUrl is not a category URL: "${currentUrl}"`);
  }

  const tree = $(NAV_TREE_ROOT_UL);
  const navTreePresent = tree.length > 0;
  if (!navTreePresent) {
    return { categories: [], navTreePresent };
  }

  const found = new Map<string, string>();

  tree.each((_, treeNode) => {
    $(treeNode)
      .find(BROWSE_ITEM_LI)
      .each((_, li) => {
        const liClass = $(li).attr("class") ?? "";
        const anchor = $(li).find("a[href]").first();
        const rawHref = anchor.attr("href");
        if (!rawHref) return;

        if (!isCategoryUrl(rawHref)) return;

        const text = anchor.text().replace(/\s+/g, " ").trim();
        if (!text || isAncestorLink(rawHref, liClass, text)) return;

        let normalized: string;
        try {
          normalized = normalizeCategoryUrl(rawHref);
        } catch {
          return;
        }

        if (normalized === currentNormalized) return;

        if (!found.has(normalized)) {
          found.set(normalized, text);
        }
      });
  });

  return {
    categories: [...found].map(([url, name]) => ({ name, url })),
    navTreePresent,
  };
}
