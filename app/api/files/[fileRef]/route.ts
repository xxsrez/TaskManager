import {
  deleteStoredFile,
  getUnboundStoredFile,
  publicStoredFile,
} from "@/lib/attachments";
import { ValidationError } from "@/lib/domain";
import { withUser } from "@/lib/http";

type Context = { params: Promise<{ fileRef: string }> };

export async function GET(_request: Request, context: Context) {
  const { fileRef } = await context.params;
  return withUser(async (user) => ({
    file: publicStoredFile(await getUnboundStoredFile(user, fileRef)),
  }));
}

export async function DELETE(request: Request, context: Context) {
  const { fileRef } = await context.params;
  return withUser(async (user) => ({
    file: publicStoredFile(await deleteStoredFile(
      user,
      fileRef,
      requiredVersion(request.headers.get("x-file-version")),
    )),
  }));
}

function requiredVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ValidationError("Stored file version is required");
  }
  return version;
}
