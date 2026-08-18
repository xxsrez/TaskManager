import { getRuntimeEnvironment } from "./runtime-environment";

export function attachmentStorageScope() {
  const env = getRuntimeEnvironment();
  const configured = env.TASK_MANAGER_ATTACHMENT_SCOPE?.trim();
  const originHost = env.TASK_MANAGER_PUBLIC_ORIGIN
    ? new URL(env.TASK_MANAGER_PUBLIC_ORIGIN).hostname
    : "local";
  const scope = (configured || originHost)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  if (!scope || scope.length > 100) {
    throw new Error("Attachment storage scope is invalid");
  }
  return scope;
}
