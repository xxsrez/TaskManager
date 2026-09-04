import { readFileSync } from "node:fs";

const taskTrackerModules = [
  "../components/task-tracker.tsx",
  "../components/task-tracker-state.tsx",
  "../components/task-tracker-system-export.ts",
  "../components/task-tracker-teams-controller.ts",
  "../components/task-tracker-catalog-controller.ts",
  "../components/task-tracker-deletion-integration-controller.ts",
  "../components/task-tracker-deletion-controller.ts",
  "../components/task-tracker-mutation-controller.ts",
  "../components/task-tracker-keyboard-controller.ts",
  "../components/task-tracker-contextual-actions.ts",
  "../components/task-tracker-query-controller.ts",
  "../components/task-tracker-grouping-controller.ts",
  "../components/task-tracker-navigation-controller.ts",
  "../components/task-tracker-surface-router.tsx",
  "../components/task-tracker-sidebar.tsx",
  "../components/task-tracker-header.tsx",
  "../components/task-tracker-overlay-host.tsx",
  "../components/task-tracker-sync-controller.ts",
  "../components/task-tracker-detail-controller.ts",
  "../components/task-tracker-shell-controller.ts",
  "../components/task-tracker-view-model.ts",
  "../components/task-tracker-dialogs.tsx",
  "../components/task-tracker-tasks.tsx",
  "../components/task-tracker-view.tsx",
];

export function readTaskTrackerSource(testModuleUrl: string) {
  return taskTrackerModules
    .map((path) => readFileSync(new URL(path, testModuleUrl), "utf8"))
    .join("\n");
}
