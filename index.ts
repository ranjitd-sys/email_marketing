import * as cheerio from "cheerio";

const url = "https://www.amazon.in/dp/B086374DS9";

const response = await fetch(url);
const html = await response.text();

const $ = cheerio.load(html);


const product = {
  asin: "B086374DS9",

  title: $("#productTitle")
    .text()
    .replace(/\s+/g, " ")
    .trim(),

  brand: $("#bylineInfo")
    .text()
    .replace(/\s+/g, " ")
    .trim(),

  price: $(".a-price .a-offscreen")
    .first()
    .text()
    .trim(),

  rating: $("#acrPopover")
    .attr("title") ?? null,

  reviewCount: $("#acrCustomerReviewText")
    .text()
    .trim(),

  availability: $("#availability")
    .text()
    .replace(/\s+/g, " ")
    .trim(),

  features: $("#feature-bullets li")
    .map((_, el) =>
      $(el).text().replace(/\s+/g, " ").trim()
    )
    .get()
    .filter(Boolean),

  description: $("#productDescription")
    .text()
    .replace(/\s+/g, " ")
    .trim(),

  images: $("#altImages img")
    .map((_, el) => $(el).attr("src"))
    .get()
    .filter(Boolean),
};

// --------------------------------
// PRODUCT DETAILS
// --------------------------------

const productDetails: Record<string, string> = {};

$("tr").each((_, row) => {
  const cells = $(row)
    .find("th, td")
    .map((_, cell) =>
      $(cell).text().replace(/\s+/g, " ").trim()
    )
    .get();

  if (cells.length === 2) {
    const [key, value] = cells;

    if (key && value) {
      productDetails[key] = value;
    }
  }
});

// --------------------------------
// SELLER
// --------------------------------

const seller = {
  name:
    $("#sellerProfileTriggerId")
      .text()
      .replace(/\s+/g, " ")
      .trim() || null,

  soldBy:
    $("#merchantInfoFeature_feature_div")
      .text()
      .replace(/\s+/g, " ")
      .trim() || null,
};

// --------------------------------
// FIND PUBLIC EMAILS IN HTML
// --------------------------------

const emails = [
  ...html.matchAll(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
  ),
].map(match => match[0].toLowerCase());

const uniqueEmails = [...new Set(emails)];


const result = {
  url,
  product,
  productDetails,
  seller,
  emails: uniqueEmails,
};

console.log(
  JSON.stringify(result, null, 2)
);