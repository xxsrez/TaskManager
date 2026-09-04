"use client";

import type { Priority, TaskRecord } from "@/lib/types";

export type Dialog =
  | "task"
  | "project"
  | "projectEdit"
  | "release"
  | "releaseEdit"
  | "view"
  | "viewEdit"
  | "share"
  | "systemExport"
  | "systemImport"
  | "codexSetup"
  | "workflowSettings"
  | "labelSettings"
  | "labelGroupSettings"
  | "bulkProject"
  | "bulkRelease"
  | "teamCreate"
  | "teamRename"
  | "teamMemberAdd"
  | "teamMemberDelete"
  | null;

export type AsyncValue<T> =
  | { status: "idle"; value: null; error: "" }
  | { status: "loading"; value: T | null; error: "" }
  | { status: "ready"; value: T; error: "" }
  | { status: "error"; value: T | null; error: string };

export type TaskCreateDefaults = Partial<{
  statusId: string;
  priority: Priority;
  assigneeUserId: string | null;
  projectId: string | null;
  releaseId: string | null;
  labelId: string | null;
}>;

export type TaskSearchState = {
  query: string;
  taskIds: string[];
  tasks: TaskRecord[];
  status: "ready" | "error";
  page?: {
    hasMore: boolean;
    next: { sortValue: string | number; rank: number; publicId: string } | null;
  } | null;
};

export type PendingProjectGroupMove = {
  taskId: string;
  targetProjectId: string;
};
