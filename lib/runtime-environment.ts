export type TaskManagerRuntimeEnvironment = {
  DB?: D1Database;
  TASK_MANAGER_ADMIN_EMAILS?: string;
  TASK_MANAGER_PUBLIC_ORIGIN?: string;
  TASK_MANAGER_OAUTH_CLIENT_ORIGINS?: string;
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
