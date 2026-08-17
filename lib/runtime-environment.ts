export type TaskManagerRuntimeEnvironment = {
  DB?: D1Database;
  ATTACHMENTS?: R2Bucket;
  TASK_MANAGER_ADMIN_EMAILS?: string;
  TASK_MANAGER_PUBLIC_ORIGIN?: string;
  TASK_MANAGER_OAUTH_CLIENT_ORIGINS?: string;
  TASK_MANAGER_ATTACHMENT_SCOPE?: string;
  TASK_MANAGER_ATTACHMENT_MAX_BYTES?: string;
  TASK_MANAGER_ATTACHMENT_MAX_COUNT?: string;
  TASK_MANAGER_ATTACHMENT_MAX_IMAGE_PIXELS?: string;
  TASK_MANAGER_ATTACHMENT_UPLOAD_TIMEOUT_SECONDS?: string;
  TASK_MANAGER_ATTACHMENT_DELETE_GRACE_SECONDS?: string;
  TASK_MANAGER_ATTACHMENT_FAILED_RETENTION_SECONDS?: string;
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
