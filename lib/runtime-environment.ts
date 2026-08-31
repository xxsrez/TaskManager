export type TaskManagerImagesBinding = {
  input(stream: ReadableStream): {
    transform(options: Record<string, unknown>): {
      output(options: {
        format: string;
        quality: number;
      }): Promise<{ response(): Response }>;
    };
  };
};

export type TaskManagerRuntimeEnvironment = {
  DB?: D1Database;
  ATTACHMENTS?: R2Bucket;
  IMAGES?: TaskManagerImagesBinding;
  TASK_MANAGER_ADMIN_EMAILS?: string;
  TASK_MANAGER_PUBLIC_ORIGIN?: string;
  TASK_MANAGER_OAUTH_CLIENT_ORIGINS?: string;
  TASK_MANAGER_ATTACHMENT_SCOPE?: string;
  TASK_MANAGER_ATTACHMENT_MAX_BYTES?: string;
  TASK_MANAGER_ATTACHMENT_MAX_COUNT?: string;
  TASK_MANAGER_ATTACHMENT_MAX_OWNER_BYTES?: string;
  TASK_MANAGER_ATTACHMENT_MAX_PROJECT_BYTES?: string;
  TASK_MANAGER_ATTACHMENT_MAX_IMAGE_PIXELS?: string;
  TASK_MANAGER_ATTACHMENT_UPLOAD_TIMEOUT_SECONDS?: string;
  TASK_MANAGER_ATTACHMENT_DELETE_GRACE_SECONDS?: string;
  TASK_MANAGER_ATTACHMENT_FAILED_RETENTION_SECONDS?: string;
  TASK_MANAGER_STORED_FILE_MAX_COUNT?: string;
  TASK_MANAGER_STORED_FILE_MAX_BYTES?: string;
  TASK_MANAGER_STORED_FILE_READY_TTL_SECONDS?: string;
  TASK_MANAGER_ATTACHMENT_MIGRATION_HOSTS?: string;
  TASK_MANAGER_BENCHMARK_TEAM_RESET_ENABLED?: string;
  TASK_MANAGER_BENCHMARK_TEAM_RESET_TOKEN?: string;
};

let runtimeEnvironment: TaskManagerRuntimeEnvironment | null = null;

export function configureRuntimeEnvironment(
  environment: TaskManagerRuntimeEnvironment,
) {
  runtimeEnvironment = environment;
}

export function getRuntimeEnvironment(): TaskManagerRuntimeEnvironment {
  if (!runtimeEnvironment) {
    throw new Error("Task Manager runtime environment is not configured");
  }
  return runtimeEnvironment;
}

export function resetRuntimeEnvironmentForTests() {
  runtimeEnvironment = null;
}
