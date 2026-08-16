const CURSOR_PREFIX = "tm-workspace-sync:v1:";

export function encodeWorkspaceSyncCursor(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Workspace sync sequence must be a non-negative integer");
  }
  return btoa(`${CURSOR_PREFIX}${sequence}`)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeWorkspaceSyncCursor(value: string): number | null {
  if (!value || value.length > 256) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = atob(padded);
    if (!decoded.startsWith(CURSOR_PREFIX)) return null;
    const sequence = Number(decoded.slice(CURSOR_PREFIX.length));
    return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
  } catch {
    return null;
  }
}
