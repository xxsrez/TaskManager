import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";
const { d1, r2 } = hostingConfig;
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const localVariables = Object.fromEntries(
  [
    "TASK_MANAGER_ADMIN_EMAILS",
    "TASK_MANAGER_PUBLIC_ORIGIN",
    "TASK_MANAGER_OAUTH_CLIENT_ORIGINS",
    "TASK_MANAGER_ATTACHMENT_SCOPE",
    "TASK_MANAGER_ATTACHMENT_MAX_BYTES",
    "TASK_MANAGER_ATTACHMENT_MAX_COUNT",
    "TASK_MANAGER_ATTACHMENT_MAX_IMAGE_PIXELS",
    "TASK_MANAGER_ATTACHMENT_UPLOAD_TIMEOUT_SECONDS",
    "TASK_MANAGER_ATTACHMENT_DELETE_GRACE_SECONDS",
    "TASK_MANAGER_ATTACHMENT_FAILED_RETENTION_SECONDS",
  ]
    .map((name) => [name, process.env[name]])
    .filter((entry): entry is [string, string] => Boolean(entry[1])),
);

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "task-manager-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: [
    {
      binding: r2 || "ATTACHMENTS",
      bucket_name: "task-manager-attachments-local",
    },
  ],
  ...(Object.keys(localVariables).length ? { vars: localVariables } : {}),
};

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
