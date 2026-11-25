export interface PageRequest {
  cursor: import('./cursor-codec.js').CursorValue | null;
  limit: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export function buildCursorPage<T>(
  records: readonly T[],
  limit: number,
  encodeCursor: (item: T) => string,
): CursorPage<T> {
  const hasNextPage = records.length > limit;
  const items = records.slice(0, limit);
  return {
    items,
    nextCursor:
      hasNextPage && items.length > 0
        ? encodeCursor(items[items.length - 1])
        : null,
  };
}
