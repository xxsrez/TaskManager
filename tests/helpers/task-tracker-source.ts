import { readFileSync } from "node:fs";

const taskTrackerModules = [
  "../components/task-tracker.tsx",
  "../components/task-tracker-state.tsx",
  "../components/task-tracker-system-export.ts",
  "../components/task-tracker-teams-controller.ts",
  "../components/task-tracker-catalog-controller.ts",
  "../components/task-tracker-deletion-controller.ts",
  "../components/task-tracker-mutation-controller.ts",
  "../components/task-tracker-keyboard-controller.ts",
  "../components/task-tracker-contextual-actions.ts",
  "../components/task-tracker-dialogs.tsx",
  "../components/task-tracker-tasks.tsx",
  "../components/task-tracker-view.tsx",
];

export function readTaskTrackerSource(testModuleUrl: string) {
  return taskTrackerModules
    .map((path) => readFileSync(new URL(path, testModuleUrl), "utf8"))
    .join("\n");
}
