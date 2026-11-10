/**
 * Which ids the History page should ask for in its first request.
 * Resume points already in the first grid page ride along with that page.
 * Resume points further down the opened list are appended, so Continue does not make a second request.
 */

export function historyPageIds(historyIds, resumeIds, pageSize) {
  const size = Math.max(1, Number(pageSize) || 1);
  const first = (historyIds || []).slice(0, size);
  const have = new Set(first);
  const extra = [];
  for (const id of resumeIds || []) {
    if (!id || have.has(id) || extra.includes(id)) continue;
    extra.push(id);
  }
  return { first, extra, asked: [...first, ...extra] };
}
