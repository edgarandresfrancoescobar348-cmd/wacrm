export const PAGE_SIZE = 1000;
export const IN_CHUNK_SIZE = 100;

export interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export function chunk<T>(values: readonly T[], size = IN_CHUNK_SIZE): T[][] {
  if (size < 1) throw new RangeError('chunk size must be at least 1');
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

/**
 * A filter list for `.in()`, sliced by the length it takes in the URL.
 * PostgREST filters travel in the query string, and the gateway in front
 * of it refuses a request line over ~8 KB with "URI too long" (414): a
 * count-based slice isn't enough when the values are long — a WhatsApp
 * message id is 50–100 characters once encoded. Each slice stays under
 * `maxChars` encoded characters and `maxItems` values.
 */
export const IN_URL_BUDGET = 3000;

export function chunkForUrl<T extends string | number>(
  values: readonly T[],
  maxChars = IN_URL_BUDGET,
  maxItems = IN_CHUNK_SIZE,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const v of values) {
    // quotes (%22 ×2) a value with reserved characters may get, plus the comma
    const cost = encodeURIComponent(String(v)).length + 7;
    if (current.length && (used + cost > maxChars || current.length >= maxItems)) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(v);
    used += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize = PAGE_SIZE,
): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const { data, error } = await fetchPage(
      rows.length,
      rows.length + pageSize - 1,
    );
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return rows;
    for (const row of data) rows.push(row);
  }
}

export async function fetchPagesUpTo<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  maxRows: number,
  pageSize = PAGE_SIZE,
): Promise<T[]> {
  const rows: T[] = [];
  while (rows.length < maxRows) {
    const to = Math.min(rows.length + pageSize, maxRows) - 1;
    const { data, error } = await fetchPage(rows.length, to);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return rows;
    for (const row of data) {
      if (rows.length >= maxRows) break;
      rows.push(row);
    }
  }
  return rows;
}

export async function fetchAllInChunks<T, V>(
  values: readonly V[],
  fetchPage: (
    values: V[],
    from: number,
    to: number,
  ) => PromiseLike<PageResult<T>>,
  chunkSize = IN_CHUNK_SIZE,
  pageSize = PAGE_SIZE,
): Promise<T[]> {
  const rows: T[] = [];
  for (const slice of chunk(values, chunkSize)) {
    const page = await fetchAllPages(
      (from, to) => fetchPage(slice, from, to),
      pageSize,
    );
    for (const row of page) rows.push(row);
  }
  return rows;
}
