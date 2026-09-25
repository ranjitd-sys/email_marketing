export const BRAND_STATUSES = ["PENDING", "PROCESSING", "COMPLETED", "FAILED"] as const;

export type BrandStatus = (typeof BRAND_STATUSES)[number];

export type BrandSource =
  | "json_ld_product"
  | "detail_spec_brand"
  | "detail_spec_brand_name"
  | "byline_store"
  | "card_metadata";

export interface BrandRecord {
  id: number;
  name: string;
  normalizedName: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategoryBrandRecord {
  categoryId: number;
  brandId: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface ProductResultEntry {
  asin: string;
  productUrl: string;
  title: string | null;
  rank: number | null;
}

export interface ProductResultPage {
  products: ProductResultEntry[];
  nextPageUrl: string | null;
}

export interface BrandExtraction {
  brand: string;
  source: BrandSource;
}

export type BrandExtractionFailure =
  | "no_product_markers"
  | "no_brand_metadata"
  | "brand_metadata_empty"
  | "brand_not_plausible";

export interface BrandExtractionResult {
  asin: string;
  extraction: BrandExtraction | null;
  reason: BrandExtractionFailure | null;
}

export interface NewBrandInput {
  name: string;
  normalizedName: string;
}

export interface BrandCrawlTarget {
  categoryId: number;
  categoryName: string;
  categoryUrl: string;
  depth: number;
  crawlOrder: number;
  brandStatus: BrandStatus;
  brandAttempts: number;
  claimOrigin: ClaimOrigin;
}

export type ClaimOrigin = "pending" | "reclaimed";

export interface BrandCrawlStateCounts {
  totalCategories: number;
  pendingCategories: number;
  processingCategories: number;
  completedCategories: number;
  failedCategories: number;
}

export interface BrandBatchSummary {
  processedCategories: number;
  failedCategories: number;
  reclaimedCategories: number;
  uniqueBrandsDiscovered: number;
  relationshipsCreated: number;
  lastProcessedCrawlOrder: number;
  remainingPendingCategories: number;
  brandCategoriesPending: number;
  brandCategoriesProcessing: number;
  brandCategoriesCompleted: number;
  brandCategoriesFailed: number;
  brandsDiscoveredTotal: number;
  categoryBrandRelationshipsTotal: number;
}
