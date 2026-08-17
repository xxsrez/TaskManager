import { getRuntimeEnvironment } from "../lib/runtime-environment";

export function getD1(): D1Database {
  const binding = getRuntimeEnvironment().DB;
  if (!binding) throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  return binding;
}

export function getAttachmentBucket(): R2Bucket {
  const binding = getRuntimeEnvironment().ATTACHMENTS;
  if (!binding) {
    throw new Error("Cloudflare R2 binding `ATTACHMENTS` is unavailable.");
  }
  return binding;
}
