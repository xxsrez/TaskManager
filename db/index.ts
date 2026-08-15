import { getRuntimeEnvironment } from "../lib/runtime-environment";

export function getD1(): D1Database {
  const binding = getRuntimeEnvironment().DB;
  if (!binding) throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  return binding;
}
