import type { Layout } from "./navigation";

export function formatReleaseName(
  projectName: string | null | undefined,
  releaseName: string,
): string {
  return [projectName?.trim(), releaseName.trim()].filter(Boolean).join(" ");
}

export function formatReleaseDocumentTitle(
  projectName: string | null | undefined,
  releaseName: string,
  layout: Layout,
): string {
  const label = formatReleaseName(projectName, releaseName);
  return `${label}${layout === "board" ? " board" : ""} – Task Manager`;
}
