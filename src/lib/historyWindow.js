export const HISTORY_WINDOW_BATCH_SIZE = 100;

const safeCount = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.floor(numeric)
    : fallback;
};

export function createHistoryWindow(history, requestedLimit = HISTORY_WINDOW_BATCH_SIZE) {
  const entries = Array.isArray(history) ? history : [];
  const limit = safeCount(requestedLimit, HISTORY_WINDOW_BATCH_SIZE);
  const startIndex = Math.max(0, entries.length - limit);
  return {
    entries: entries.slice(startIndex),
    hiddenCount: startIndex,
    visibleCount: entries.length - startIndex,
    totalCount: entries.length,
  };
}

export function expandHistoryWindowLimit(currentLimit, totalCount, batchSize = HISTORY_WINDOW_BATCH_SIZE) {
  const total = Math.max(0, safeCount(totalCount, 0));
  const batch = safeCount(batchSize, HISTORY_WINDOW_BATCH_SIZE);
  const current = safeCount(currentLimit, batch);
  return Math.min(total, current + batch);
}
