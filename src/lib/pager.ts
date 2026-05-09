/**
 * URL-driven pager state for paginated list views.
 *
 * Reads `?page=N&size=M` from URLSearchParams, validates them, and
 * clamps `size` to a sane upper bound to avoid abuse / runaway
 * queries.
 *
 * Defaults: page=1, size=50, max size=200.
 */

export interface PagerState {
  page: number;
  size: number;
}

export const DEFAULT_PAGE = 1;
export const DEFAULT_SIZE = 50;
export const MAX_SIZE = 200;

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

export function parsePager(searchParams: URLSearchParams): PagerState {
  const page = parsePositiveInt(searchParams.get("page"), DEFAULT_PAGE);
  const rawSize = parsePositiveInt(searchParams.get("size"), DEFAULT_SIZE);
  const size = Math.min(rawSize, MAX_SIZE);
  return { page, size };
}

export function totalPages(totalCount: number, size: number): number {
  if (totalCount <= 0 || size <= 0) return 1;
  return Math.max(1, Math.ceil(totalCount / size));
}
