export const CATEGORY_STATUSES = ["PENDING", "PROCESSING", "COMPLETED", "FAILED"] as const;

export type CategoryStatus = (typeof CATEGORY_STATUSES)[number];

export interface NewCategory {
  name: string;
  url: string;
  parentId: number | null;
  depth: number;
}

export interface ParsedCategory {
  name: string;
  url: string;
}

export interface ParseResult {
  categories: ParsedCategory[];
  navTreePresent: boolean;
}

export interface SaveCategoryResult {
  record: CategoryRecord;
  isNew: boolean;
}

export interface CategoryRecord {
  id: number;
  name: string;
  url: string;
  parentId: number | null;
  depth: number;
  crawlOrder: number;
  status: CategoryStatus;
  processingStartedAt: Date | null;
  processedAt: Date | null;
  createdAt: Date;
}

export interface CrawlSummary {
  totalCount: number;
  pendingCount: number;
  processingCount: number;
  completedCount: number;
  failedCount: number;
  remainingPendingCount: number;
  lastProcessedCrawlOrder: number;
}