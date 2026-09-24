import * as cheerio from "cheerio";
import { saveCategory } from "./db";

const BASE_URL = "https://www.amazon.in";
const START_URL = `${BASE_URL}/gp/bestsellers/`;

type Category = {
  name: string;
  url: string;
  parentUrl: string | null;
  depth: number;
  children: Category[];
};

const categories = new Map<string, Category>();
const visited = new Set<string>();

function normalizeUrl(href: string): string | null {
  try {
    const url = new URL(href, BASE_URL);

    // Only Amazon India
    if (url.hostname !== "www.amazon.in") {
      return null;
    }

    // Only bestseller pages
    if (!url.pathname.startsWith("/gp/bestsellers")) {
      return null;
    }

    // Remove /ref=... from the path
    const refIndex = url.pathname.indexOf("/ref=");

    if (refIndex !== -1) {
      url.pathname = url.pathname.slice(0, refIndex);
    }

    // Remove query/hash
    url.search = "";
    url.hash = "";

    // Normalize trailing slash
    if (!url.pathname.endsWith("/")) {
      url.pathname += "/";
    }

    return url.href;
  } catch {
    return null;
  }
}

function extractCategories(
  html: string,
  currentUrl: string
) {
  const $ = cheerio.load(html);

  const found = new Map<string, string>();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");

    if (!href) return;

    const url = normalizeUrl(href);

    if (!url) return;

    if (url === currentUrl) return;

    const name = $(element)
      .text()
      .replace(/\s+/g, " ")
      .trim();

    if (!name) return;

    found.set(url, name);
  });

  console.log("\nCATEGORY CANDIDATES:");

  for (const [url, name] of found) {
    console.log(name, "=>", url);
  }

  return [...found].map(([url, name]) => ({
    url,
    name,
  }));
}

async function crawlCategory(
  name: string,
  url: string,
  parent: Category | null,
  depth: number,
  parentId: number | null
) {
  if (visited.has(url)) {
    return;
  }

  visited.add(url);

  console.log(
    `${"  ".repeat(depth)}${name}`
  );

  const response = await fetch(url);

  if (!response.ok) {
    console.log(
      `${"  ".repeat(depth)}FAILED ${response.status}`
    );
    return;
  }

  const html = await response.text();

  const current: Category = {
    name,
    url,
    parentUrl: parent?.url ?? null,
    depth,
    children: [],
  };

  categories.set(url, current);

  const children = extractCategories(
    html,
    url
  );

  for (const child of children) {
    if (visited.has(child.url)) {
      continue;
    }

    // SAVE CHILD HERE
    const childId = await saveCategory(
      child.name,
      child.url,
      parentId,
      depth + 1
    );

    console.log(
      `Saved: ${child.name}, id=${childId}`
    );

    const childCategory: Category = {
      name: child.name,
      url: child.url,
      parentUrl: url,
      depth: depth + 1,
      children: [],
    };

    current.children.push(childCategory);

    categories.set(
      child.url,
      childCategory
    );

    // NOW CRAWL THE CHILD
    await crawlCategory(
      child.name,
      child.url,
      current,
      depth + 1,
      childId
    );
  }
}

async function main() {
  const rootId = await saveCategory(
    "Any Department",
    START_URL,
    null,
    0
  );

  await crawlCategory(
    "Any Department",
    START_URL,
    null,
    0,
    rootId
  );

  console.log(
    `Total categories: ${categories.size}`
  );
}

main().catch(console.error);

function printTree(category: Category) {
  console.log(
    `${"  ".repeat(category.depth)}${category.name}`
  );

  for (const child of category.children) {
    printTree(child);
  }
}

main().catch(console.error);