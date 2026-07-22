export const HISTORY_WINDOW_BATCH_SIZE = 100;

const safeCount = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.floor(numeric)
    : fallback;
};

const maximumPageOffset = (total, batch) => (
  total > 0 ? Math.floor((total - 1) / batch) * batch : 0
);

const normalizePageOffset = (value, maximumOffset, batch) => {
  const numeric = Number(value);
  const requested = Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
  return Math.min(maximumOffset, Math.floor(requested / batch) * batch);
};

export function createHistoryWindow(
  history,
  requestedOffset = 0,
  batchSize = HISTORY_WINDOW_BATCH_SIZE,
) {
  const entries = Array.isArray(history) ? history : [];
  const batch = safeCount(batchSize, HISTORY_WINDOW_BATCH_SIZE);
  const maximumOffset = maximumPageOffset(entries.length, batch);
  const offset = normalizePageOffset(requestedOffset, maximumOffset, batch);
  const endIndex = Math.max(0, entries.length - offset);
  const startIndex = Math.max(0, endIndex - batch);
  return {
    entries: entries.slice(startIndex, endIndex),
    olderCount: startIndex,
    newerCount: entries.length - endIndex,
    visibleCount: endIndex - startIndex,
    totalCount: entries.length,
    offset: entries.length - endIndex,
  };
}

export function shiftHistoryWindowOffset(
  currentOffset,
  direction,
  totalCount,
  batchSize = HISTORY_WINDOW_BATCH_SIZE,
) {
  const total = Math.max(0, safeCount(totalCount, 0));
  const batch = safeCount(batchSize, HISTORY_WINDOW_BATCH_SIZE);
  const maximumOffset = maximumPageOffset(total, batch);
  const current = normalizePageOffset(currentOffset, maximumOffset, batch);
  if (direction === 'older') return Math.min(maximumOffset, current + batch);
  if (direction === 'newer') return Math.max(0, current - batch);
  return current;
}
