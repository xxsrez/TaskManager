export const RECENT_NAVIGATION_LIMIT = 3;

export type RecentNavigationRecord = {
  id: string;
  updatedAt?: string;
  archivedAt?: string | null;
};

/**
 * Selects the shared deterministic Recent contract used by navigation and the
 * workspace overview. The active accessible record is injected at the front
 * without allowing the shortlist to grow past its hard limit.
 */
export function selectRecentNavigation<T extends RecentNavigationRecord>(
  records: readonly T[],
  options: { activeId?: string | null; limit?: number } = {},
): T[] {
  const limit = Math.max(0, Math.trunc(options.limit ?? RECENT_NAVIGATION_LIMIT));
  if (limit === 0) return [];

  const activeId = options.activeId ?? null;
  const available = records.filter((record) => !record.archivedAt);
  const active = activeId
    ? available.find((record) => record.id === activeId)
    : undefined;
  const ordered = available
    .filter((record) => record.id !== active?.id)
    .sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) ||
      right.id.localeCompare(left.id));

  return active
    ? [active, ...ordered].slice(0, limit)
    : ordered.slice(0, limit);
}
