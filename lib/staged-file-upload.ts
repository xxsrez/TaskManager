export type PublicAttachmentRecord = {
  ref: string;
  taskId: string;
  uploaderUserId: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  checksumSha256: string;
  kind: "file" | "image";
  state: "pending" | "uploading" | "ready" | "failed" | "deleted";
  imageWidth: number | null;
  imageHeight: number | null;
  variants: Record<string, unknown>;
  failureCode: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type PublicStoredFileRecord = {
  ref: string;
  uploaderUserId: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  checksumSha256: string;
  kind: "file" | "image";
  state: "uploading" | "ready" | "failed" | "expired" | "deleted";
  imageWidth: number | null;
  imageHeight: number | null;
  variants: Record<string, unknown>;
  readyExpiresAt: string | null;
  failureCode: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type UploadProgress = (percent: number) => void;

export function startStoredFileUpload(
  file: File,
  idempotencyKey: string,
  onProgress: UploadProgress = () => undefined,
) {
  const request = new XMLHttpRequest();
  const promise = new Promise<PublicStoredFileRecord>((resolve, reject) => {
    request.open("POST", "/api/files");
    request.responseType = "json";
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.setRequestHeader("Idempotency-Key", idempotencyKey);
    request.setRequestHeader("X-File-Filename", encodeURIComponent(file.name));
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    });
    request.addEventListener("load", () => {
      const value = request.response as
        | { file: PublicStoredFileRecord }
        | { error?: string }
        | null;
      if (request.status >= 200 && request.status < 300 && value && "file" in value) {
        onProgress(100);
        resolve(value.file);
      } else {
        const message = value && "error" in value ? value.error : undefined;
        reject(new Error(message || `File upload failed (${request.status})`));
      }
    });
    request.addEventListener("error", () => reject(new Error("Network connection lost during upload")));
    request.addEventListener("abort", () => reject(new DOMException("Upload canceled", "AbortError")));
    request.send(file);
  });
  return { promise, cancel: () => request.abort() };
}

export async function bindStoredFileToTask(
  taskId: string,
  fileRef: string,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  return fetchStagedFileJson<{ attachment: PublicAttachmentRecord }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileRef, idempotencyKey }),
      signal,
    },
  ).then((value) => value.attachment);
}

export function startStagedTaskAttachmentUpload(
  taskId: string,
  file: File,
  idempotencyKey: string,
  onProgress: UploadProgress = () => undefined,
  onStaged: (file: PublicStoredFileRecord) => void = () => undefined,
) {
  const controller = new AbortController();
  let cancelUpload: () => void = () => undefined;
  const promise = (async () => {
    const upload = startStoredFileUpload(
      file,
      `${idempotencyKey}:store`,
      (progress) => onProgress(Math.min(90, Math.round(progress * 0.9))),
    );
    cancelUpload = upload.cancel;
    const stored = await upload.promise;
    onStaged(stored);
    if (controller.signal.aborted) throw new DOMException("Upload canceled", "AbortError");
    onProgress(95);
    const attachment = await bindStoredFileToTask(
      taskId,
      stored.ref,
      `${idempotencyKey}:bind`,
      controller.signal,
    );
    onProgress(100);
    return attachment;
  })();
  return {
    promise,
    cancel: () => {
      cancelUpload();
      controller.abort();
    },
  };
}

export async function getStoredFile(fileRef: string, signal?: AbortSignal) {
  return fetchStagedFileJson<{ file: PublicStoredFileRecord }>(
    `/api/files/${encodeURIComponent(fileRef)}`,
    { cache: "no-store", signal },
  ).then((value) => value.file);
}

export async function deleteStoredFile(fileRef: string, version: number) {
  return fetchStagedFileJson<{ file: PublicStoredFileRecord }>(
    `/api/files/${encodeURIComponent(fileRef)}`,
    { method: "DELETE", headers: { "X-File-Version": String(version) } },
  ).then((value) => value.file);
}

async function fetchStagedFileJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const value = await response.json() as T | { error?: string };
  if (!response.ok) {
    throw new Error(value && typeof value === "object" && "error" in value && value.error
      ? value.error
      : `File request failed (${response.status})`);
  }
  return value as T;
}
