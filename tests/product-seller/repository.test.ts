import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import {
  claimProductSellerWork,
  getTotals,
  getWorkStateCounts,
  linkBrandProduct,
  linkCategoryProduct,
  linkSellerProduct,
  markWorkFailure,
  persistWork,
  resetFailedWork,
  upsertContact,
  upsertProduct,
  upsertSeller,
} from "../../src/product-seller/repository";
import type { ParsedContact, ParsedProduct, ParsedSeller } from "../../src/product-seller/types";
import { dropTestSchema, recreateTestSchema, testClient } from "../helpers/testdb";

const SCHEMA = "ps_test_repository";
const TIMEOUT = 30_000;

let db: Db;

beforeAll(() => {
  db = testClient(SCHEMA);
});

afterAll(async () => {
  await db.end();
  await dropTestSchema(SCHEMA);
});

beforeEach(async () => {
  await recreateTestSchema(SCHEMA);
  await runMigrations(db);
});

async function seedBrand(name: string, normalized: string): Promise<number> {
  const [row] = await db`
    INSERT INTO brands (name, normalized_name)
    VALUES (${name}, ${normalized})
    ON CONFLICT (normalized_name) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `;
  return Number(row.id);
}

async function seedWork(
  categoryName: string,
  brandName: string,
  order: number
): Promise<{ categoryId: number; brandId: number }> {
  const [category] = await db`
    INSERT INTO categories (name, url, parent_id, depth, crawl_order)
    VALUES (${categoryName}, ${`https://www.amazon.in/gp/bestsellers/${order}/`}, NULL, 0, ${order})
    RETURNING id
  `;
  const brandId = await seedBrand(brandName, brandName.toLowerCase());
  const categoryId = Number(category.id);
  await db`
    INSERT INTO category_brands (category_id, brand_id)
    VALUES (${categoryId}, ${brandId})
  `;
  return { categoryId, brandId };
}

const CLAIM = {
  batchSize: 2,
  leaseTimeoutMs: 60_000,
  maxAttempts: 3,
  workerId: "ps-worker-1",
};

function makeProduct(asin: string, overrides: Partial<ParsedProduct> = {}): ParsedProduct {
  return {
    asin,
    title: `Product ${asin}`,
    brand: null,
    price: 100,
    mrp: null,
    discount: null,
    rating: null,
    reviewCount: null,
    availability: null,
    description: null,
    features: [],
    images: [],
    manufacturer: null,
    modelNumber: null,
    ...overrides,
  };
}

function makeSeller(name: string, externalId: string | null): ParsedSeller {
  return {
    name,
    normalizedName: name.toLowerCase(),
    externalId,
    profileUrl: null,
  };
}

function makeContact(value: string, entityType: ParsedContact["entityType"], context: string): ParsedContact {
  return {
    type: "EMAIL",
    value,
    normalizedValue: value.toLowerCase(),
    source: entityType === "SELLER" ? "seller_profile" : "product_page",
    sourceUrl: "https://www.amazon.in/",
    context,
    entityType,
    entityId: null,
    verificationStatus: "VALID_FORMAT",
  };
}

describe("claimProductSellerWork", () => {
  test("claims PENDING work ordered by category_id, brand_id", async () => {
    const a = await seedWork("Tripods", "Benro", 1);
    const b = await seedWork("Tripods", "Manfrotto", 2);
    await seedWork("Tripods", "Joby", 3);

    const claim = await claimProductSellerWork(db, CLAIM);
    expect(claim.claimed).toHaveLength(2);
    expect(claim.claimed[0]).toMatchObject({ categoryId: a.categoryId, brandId: a.brandId });
    expect(claim.claimed[1]).toMatchObject({ categoryId: b.categoryId, brandId: b.brandId });
    expect(claim.claimed[0]?.claimOrigin).toBe("pending");
    expect(claim.claimed[0]?.attempts).toBe(1);
    expect(claim.reclaimed).toBe(0);
  });

  test("does not hand the same work to two workers", async () => {
    await seedWork("Tripods", "Benro", 1);
    await seedWork("Tripods", "Manfrotto", 2);
    await seedWork("Tripods", "Joby", 3);

    const first = await claimProductSellerWork(db, CLAIM);
    const second = await claimProductSellerWork(db, { ...CLAIM, workerId: "ps-worker-2" });
    const firstKeys = first.claimed.map((w) => `${w.categoryId}:${w.brandId}`);
    const secondKeys = second.claimed.map((w) => `${w.categoryId}:${w.brandId}`);
    expect(firstKeys.some((k) => secondKeys.includes(k))).toBe(false);
  });

  test("reclaims work whose lease expired", async () => {
    const work = await seedWork("Tripods", "Benro", 1);
    await claimProductSellerWork(db, CLAIM);
    await db`
      UPDATE category_brands
      SET product_seller_locked_at = NOW() - INTERVAL '2 hours'
      WHERE category_id = ${work.categoryId} AND brand_id = ${work.brandId}
    `;

    const reclaimed = await claimProductSellerWork(db, { ...CLAIM, workerId: "ps-worker-2" });
    expect(reclaimed.claimed).toHaveLength(1);
    expect(reclaimed.claimed[0]?.claimOrigin).toBe("reclaimed");
    expect(reclaimed.reclaimed).toBe(1);
  });

  test("marks exhausted work FAILED", async () => {
    const work = await seedWork("Tripods", "Benro", 1);
    await db`
      UPDATE category_brands
      SET product_seller_status = 'PROCESSING', product_seller_attempts = 3,
          product_seller_locked_at = NOW() - INTERVAL '2 hours'
      WHERE category_id = ${work.categoryId} AND brand_id = ${work.brandId}
    `;

    const claim = await claimProductSellerWork(db, CLAIM);
    expect(claim.claimed).toHaveLength(0);
    expect(claim.exhaustedMarkedFailed).toBe(1);

    const rows = await db`
      SELECT product_seller_status FROM category_brands
      WHERE category_id = ${work.categoryId} AND brand_id = ${work.brandId}
    `;
    expect(rows[0].product_seller_status).toBe("FAILED");
  });
});

describe("product upsert and links", () => {
  test("dedupes products by ASIN and preserves first_seen_at", async () => {
    const brandId = await seedBrand("Benro", "benro");
    const first = await upsertProduct(db, { product: makeProduct("B004TRPV3G", { title: "First" }), brandId });
    expect(first.inserted).toBe(true);

    await db`UPDATE products SET first_seen_at = NOW() - INTERVAL '1 day' WHERE id = ${first.id}`;
    const second = await upsertProduct(db, {
      product: makeProduct("B004TRPV3G", { title: "Updated" }),
      brandId,
    });
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);

    const [row] = await db`SELECT title, first_seen_at FROM products WHERE id = ${first.id}`;
    expect(row.title).toBe("Updated");
    expect(new Date(row.first_seen_at).getTime()).toBeLessThan(Date.now() - 60_000);
  });

  test("keeps unrelated non-null values when re-upserting with nulls", async () => {
    const brandId = await seedBrand("Benro", "benro");
    const p = await upsertProduct(db, { product: makeProduct("B004TRPV3G", { price: 1999 }), brandId });
    await upsertProduct(db, { product: makeProduct("B004TRPV3G", { price: null }), brandId });
    const [row] = await db`SELECT price FROM products WHERE id = ${p.id}`;
    expect(Number(row.price)).toBe(1999);
  });

  test("records category-brand-product relationships idempotently", async () => {
    const work = await seedWork("Tripods", "Benro", 1);
    const p = await upsertProduct(db, { product: makeProduct("B004TRPV3G"), brandId: work.brandId });

    const c1 = await linkCategoryProduct(db, work.categoryId, p.id);
    const c2 = await linkCategoryProduct(db, work.categoryId, p.id);
    expect(c1.inserted).toBe(true);
    expect(c2.inserted).toBe(false);

    const b1 = await linkBrandProduct(db, work.brandId, p.id);
    const b2 = await linkBrandProduct(db, work.brandId, p.id);
    expect(b1.inserted).toBe(true);
    expect(b2.inserted).toBe(false);
  });
});

describe("seller upsert and links", () => {
  test("dedupes sellers by external id", async () => {
    const first = await upsertSeller(db, makeSeller("Shutterbug Retail Pvt Ltd", "A1SELLER001"));
    expect(first.inserted).toBe(true);
    const second = await upsertSeller(db, makeSeller("Shutterbug Retail", "A1SELLER001"));
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);

    const [count] = await db`SELECT COUNT(*)::int AS n FROM sellers`;
    expect(count.n).toBe(1);
  });

  test("dedupes sellers without an external id by conservative name identity", async () => {
    const first = await upsertSeller(db, {
      name: "Shutterbug Retail Pvt Ltd",
      normalizedName: "shutterbug retail",
      externalId: null,
      profileUrl: null,
    });
    const second = await upsertSeller(db, {
      name: "Shutterbug Retail Private Limited",
      normalizedName: "shutterbug retail",
      externalId: null,
      profileUrl: null,
    });
    expect(second.id).toBe(first.id);
  });

  test("allows the same display name with different external ids", async () => {
    const a = await upsertSeller(db, makeSeller("ABC Retail", "SELLER-A"));
    const b = await upsertSeller(db, makeSeller("ABC Retail", "SELLER-B"));
    expect(a.id).not.toBe(b.id);
  });

  test("links one seller to many products and one product to many sellers", async () => {
    const brandId = await seedBrand("Benro", "benro");
    const p1 = await upsertProduct(db, { product: makeProduct("B004TRPV3G"), brandId });
    const p2 = await upsertProduct(db, { product: makeProduct("B005BY9PPQ"), brandId });
    const x = await upsertSeller(db, makeSeller("Seller X", "SX"));
    const y = await upsertSeller(db, makeSeller("Seller Y", "SY"));

    await linkSellerProduct(db, x.id, p1.id);
    await linkSellerProduct(db, x.id, p2.id);
    await linkSellerProduct(db, y.id, p1.id);

    const rows = await db`SELECT seller_id, product_id FROM seller_products`;
    expect(rows).toHaveLength(3);
  });
});

describe("contact upsert", () => {
  test("dedupes by type/value/source/context and keeps distinct contexts", async () => {
    const seller = await upsertSeller(db, makeSeller("Shutterbug Retail", "A1SELLER001"));
    const product = makeContact("info@example.com", "MANUFACTURER", "manufacturer_contact");
    const sellerProfile = makeContact("info@example.com", "SELLER", "seller_business_contact");

    const a = await upsertContact(db, { contact: product, sellerId: null, entityId: null });
    const b = await upsertContact(db, { contact: product, sellerId: null, entityId: null });
    const c = await upsertContact(db, { contact: sellerProfile, sellerId: seller.id, entityId: seller.id });

    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(c.inserted).toBe(true);

    const rows = await db`SELECT entity_type, context FROM contacts ORDER BY id`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r: { entity_type: string }) => r.entity_type)).toEqual(["MANUFACTURER", "SELLER"]);
  });
});

describe("persistWork", () => {
  test("persists products, sellers, contacts and completes the work atomically", async () => {
    const work = await seedWork("Tripods", "Benro", 1);
    await claimProductSellerWork(db, CLAIM);

    const result = await persistWork(db, {
      categoryId: work.categoryId,
      brandId: work.brandId,
      workerId: CLAIM.workerId,
      products: [
        {
          product: makeProduct("B004TRPV3G"),
          seller: makeSeller("Shutterbug Retail Pvt Ltd", "A1SELLER001"),
          sellerContacts: [
            makeContact("support@benro-manufacturer.example", "MANUFACTURER", "manufacturer_contact"),
            makeContact("seller-support@shutterbug.example", "SELLER", "seller_business_contact"),
          ],
        },
        {
          product: makeProduct("B005BY9PPQ"),
          seller: makeSeller("Shutterbug Retail Pvt Ltd", "A1SELLER001"),
          sellerContacts: [],
        },
      ],
    });

    expect(result.uniqueProducts).toBe(2);
    expect(result.uniqueSellers).toBe(1);
    expect(result.sellerProductLinks).toBe(2);
    expect(result.contactsAccepted).toBe(2);

    const status = await db`
      SELECT product_seller_status, product_seller_locked_by, product_seller_processed_at
      FROM category_brands WHERE category_id = ${work.categoryId} AND brand_id = ${work.brandId}
    `;
    expect(status[0].product_seller_status).toBe("COMPLETED");
    expect(status[0].product_seller_locked_by).toBeNull();
    expect(status[0].product_seller_processed_at).not.toBeNull();

    const manufacturer = await db`
      SELECT entity_type, seller_id FROM contacts WHERE normalized_value = 'support@benro-manufacturer.example'
    `;
    expect(manufacturer[0].entity_type).toBe("MANUFACTURER");
    expect(manufacturer[0].seller_id).toBeNull();

    const sellerContact = await db`
      SELECT entity_type, seller_id FROM contacts WHERE normalized_value = 'seller-support@shutterbug.example'
    `;
    expect(sellerContact[0].entity_type).toBe("SELLER");
    expect(sellerContact[0].seller_id).not.toBeNull();
  });

  test("refuses to complete work whose lease was lost", async () => {
    const work = await seedWork("Tripods", "Benro", 1);
    await claimProductSellerWork(db, CLAIM);

    await expect(
      persistWork(db, {
        categoryId: work.categoryId,
        brandId: work.brandId,
        workerId: "someone-else",
        products: [],
      })
    ).rejects.toThrow(/lease no longer held/);

    const rows = await db`
      SELECT product_seller_status FROM category_brands
      WHERE category_id = ${work.categoryId} AND brand_id = ${work.brandId}
    `;
    expect(rows[0].product_seller_status).toBe("PROCESSING");
  });
});

describe("failure handling", () => {
  test("returns work to PENDING while attempts remain, FAILED at the limit", async () => {
    const work = await seedWork("Tripods", "Benro", 1);

    for (let attempt = 0; attempt < 3; attempt++) {
      await claimProductSellerWork(db, CLAIM);
      await markWorkFailure(db, {
        categoryId: work.categoryId,
        brandId: work.brandId,
        workerId: CLAIM.workerId,
        maxAttempts: 3,
      });
    }

    const rows = await db`
      SELECT product_seller_status, product_seller_attempts FROM category_brands
      WHERE category_id = ${work.categoryId} AND brand_id = ${work.brandId}
    `;
    expect(rows[0].product_seller_status).toBe("FAILED");
    expect(Number(rows[0].product_seller_attempts)).toBe(3);
  });

  test("resetFailedWork makes failed work recoverable", async () => {
    const work = await seedWork("Tripods", "Benro", 1);
    await db`
      UPDATE category_brands SET product_seller_status = 'FAILED', product_seller_attempts = 3
      WHERE category_id = ${work.categoryId} AND brand_id = ${work.brandId}
    `;
    const reset = await resetFailedWork(db);
    expect(reset).toBe(1);
    const rows = await db`
      SELECT product_seller_status, product_seller_attempts FROM category_brands
      WHERE category_id = ${work.categoryId} AND brand_id = ${work.brandId}
    `;
    expect(rows[0].product_seller_status).toBe("PENDING");
    expect(Number(rows[0].product_seller_attempts)).toBe(0);
  });
});

describe("counts", () => {
  test("reports work-state and entity totals", async () => {
    await seedWork("Tripods", "Benro", 1);
    await seedWork("Tripods", "Manfrotto", 2);
    const counts = await getWorkStateCounts(db);
    expect(counts.totalWork).toBe(2);
    expect(counts.pendingWork).toBe(2);

    const brandId = await seedBrand("Benro", "benro");
    await upsertProduct(db, { product: makeProduct("B004TRPV3G"), brandId });
    const totals = await getTotals(db);
    expect(totals.totalProducts).toBe(1);
  });
});
