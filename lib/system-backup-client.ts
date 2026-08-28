import type { SystemBackupJobStatus } from "./types";

export const systemBackupActionHeaders = {
  "x-task-manager-action": "system-backup",
} as const;

export const systemBackupMediaType =
  "application/vnd.task-manager.system-backup+ndjson";
export const maxSystemBackupFrameBytes = 3_000_000;
export const systemBackupImportCheckpointKey = "task-manager:system-backup:import";
export const systemBackupSafetyExportCheckpointKey = "task-manager:system-backup:safety-export";

export type SystemBackupFrame = Record<string, unknown> & {
  frame: "header" | "rows" | "object" | "manifest";
};

export type SystemBackupCheckpoint = {
  jobId: string;
  kind: SystemBackupJobStatus["kind"];
  relatedJobId?: string;
  file?: {
    name: string;
    size: number;
    lastModified: number;
  };
};

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type BackupRequest = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type BackupJobProgress = (status: SystemBackupJobStatus) => void;
export type BackupConnectionState = (waiting: boolean) => void;

export class SystemBackupClientError extends Error {
  readonly code:
    | "bad_file"
    | "expired"
    | "network"
    | "server"
    | "stopped";

  constructor(
    code: SystemBackupClientError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SystemBackupClientError";
    this.code = code;
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function concatBytes(left: Uint8Array, right: Uint8Array) {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function parseFrame(line: Uint8Array, lineNumber: number): SystemBackupFrame {
  if (line.byteLength === 0) {
    throw new SystemBackupClientError(
      "bad_file",
      `Пустая строка в backup-файле (${lineNumber}).`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(line));
  } catch (error) {
    throw new SystemBackupClientError(
      "bad_file",
      `Строка ${lineNumber} повреждена или не является JSON.`,
      { cause: error },
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SystemBackupClientError(
      "bad_file",
      `Строка ${lineNumber} не содержит допустимый frame.`,
    );
  }
  const frame = (value as Record<string, unknown>).frame;
  if (frame !== "header" && frame !== "rows" && frame !== "object" && frame !== "manifest") {
    throw new SystemBackupClientError(
      "bad_file",
      `Строка ${lineNumber} содержит неизвестный тип frame.`,
    );
  }
  return value as SystemBackupFrame;
}

/**
 * Reads one NDJSON frame at a time. The retained buffer is capped, so a large
 * backup never becomes one browser string or Blob copy.
 */
export async function* readSystemBackupFrames(
  source: Blob,
  maximumFrameBytes = maxSystemBackupFrameBytes,
): AsyncGenerator<SystemBackupFrame> {
  const reader = source.stream().getReader();
  let pending = new Uint8Array(0);
  let lineNumber = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      pending = concatBytes(pending, result.value);
      let lineStart = 0;
      for (let index = 0; index < pending.byteLength; index += 1) {
        if (pending[index] !== 10) continue;
        const lineEnd = index > lineStart && pending[index - 1] === 13
          ? index - 1
          : index;
        const line = pending.slice(lineStart, lineEnd);
        if (line.byteLength > maximumFrameBytes) {
          throw new SystemBackupClientError(
            "bad_file",
            `Строка ${lineNumber + 1} превышает допустимый размер frame.`,
          );
        }
        lineNumber += 1;
        yield parseFrame(line, lineNumber);
        lineStart = index + 1;
      }
      pending = pending.slice(lineStart);
      if (pending.byteLength > maximumFrameBytes) {
        throw new SystemBackupClientError(
          "bad_file",
          `Строка ${lineNumber + 1} превышает допустимый размер frame.`,
        );
      }
    }
    if (pending.byteLength > 0) {
      lineNumber += 1;
      yield parseFrame(pending, lineNumber);
    }
  } finally {
    reader.releaseLock();
  }
}

function isJobStatus(value: unknown): value is SystemBackupJobStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.jobId === "string"
    && (candidate.kind === "export" || candidate.kind === "import" || candidate.kind === "rollback")
    && typeof candidate.status === "string"
    && typeof candidate.phase === "string"
    && !!candidate.progress
    && typeof candidate.progress === "object";
}

async function responseStatus(
  response: Response,
  fallback: string,
): Promise<SystemBackupJobStatus> {
  const value = await response.json().catch(() => null) as unknown;
  if (!response.ok || !isJobStatus(value)) {
    throw new SystemBackupClientError(
      response.status === 404 || response.status === 410 ? "expired" : "server",
      fallback,
    );
  }
  return value;
}

export function backupJobIsTerminal(status: SystemBackupJobStatus) {
  return status.status === "ready"
    || status.status === "applied"
    || status.status === "failed"
    || status.status === "expired";
}

export function backupJobSucceeded(status: SystemBackupJobStatus) {
  return status.kind === "import"
    ? status.status === "ready" || status.status === "applied"
    : status.status === "ready";
}

export function backupImportIsFullyValidated(status: SystemBackupJobStatus | null) {
  return !!status
    && status.kind === "import"
    && status.status === "ready"
    && status.phase === "ready"
    && !!status.rootSha256
    && status.validationErrors.length === 0;
}

export function canApplySystemBackupImport(
  status: SystemBackupJobStatus | null,
  safetyDownloadStarted: boolean,
  confirmation: string,
) {
  return backupImportIsFullyValidated(status)
    && safetyDownloadStarted
    && confirmation === "RESTORE";
}

export function retainBackupCheckpoint(status: SystemBackupJobStatus) {
  if (status.status === "failed" || status.status === "expired" || status.status === "applied") {
    return false;
  }
  return true;
}

export function readBackupCheckpoint(
  storage: StorageLike,
  key: string,
): SystemBackupCheckpoint | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SystemBackupCheckpoint>;
    if (
      typeof value.jobId !== "string"
      || (value.kind !== "export" && value.kind !== "import" && value.kind !== "rollback")
    ) {
      storage.removeItem(key);
      return null;
    }
    if (value.relatedJobId !== undefined && typeof value.relatedJobId !== "string") {
      storage.removeItem(key);
      return null;
    }
    if (value.file && (
      typeof value.file.name !== "string"
      || typeof value.file.size !== "number"
      || typeof value.file.lastModified !== "number"
    )) {
      storage.removeItem(key);
      return null;
    }
    return value as SystemBackupCheckpoint;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function writeBackupCheckpoint(
  storage: StorageLike,
  key: string,
  checkpoint: SystemBackupCheckpoint | null,
) {
  if (!checkpoint) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify(checkpoint));
}

export async function getBackupJobStatus(
  jobId: string,
  request: BackupRequest = fetch,
): Promise<SystemBackupJobStatus> {
  const kind = jobId.startsWith("system-import:") ? "import" : "export";
  let response: Response;
  try {
    response = await request(
      `/api/admin/${kind}/${encodeURIComponent(jobId)}/status`,
      { headers: systemBackupActionHeaders, cache: "no-store" },
    );
  } catch (error) {
    throw new SystemBackupClientError(
      "network",
      "Не удалось получить состояние операции. Проверьте соединение и повторите.",
      { cause: error },
    );
  }
  return responseStatus(response, "Сервер не вернул состояние операции.");
}

export async function createSystemBackupExport(
  request: BackupRequest = fetch,
  options: { fresh?: boolean } = {},
): Promise<SystemBackupJobStatus> {
  let response: Response;
  try {
    response = await request(options.fresh ? "/api/admin/export?fresh=1" : "/api/admin/export", {
      method: "POST",
      headers: systemBackupActionHeaders,
    });
  } catch (error) {
    throw new SystemBackupClientError(
      "network",
      "Не удалось начать экспорт. Проверьте соединение и повторите.",
      { cause: error },
    );
  }
  return responseStatus(response, "Сервер не смог начать экспорт.");
}

export async function getCurrentSystemBackupExport(
  request: BackupRequest = fetch,
): Promise<SystemBackupJobStatus | null> {
  let response: Response;
  try {
    response = await request("/api/admin/export/current", {
      headers: systemBackupActionHeaders,
      cache: "no-store",
    });
  } catch (error) {
    throw new SystemBackupClientError(
      "network",
      "Не удалось проверить незавершённый экспорт.",
      { cause: error },
    );
  }
  const value = await response.json().catch(() => null) as unknown;
  if (!response.ok || (value !== null && !isJobStatus(value))) {
    throw new SystemBackupClientError("server", "Сервер не вернул текущий экспорт.");
  }
  return value;
}

export async function advanceSystemBackupJob(
  status: SystemBackupJobStatus,
  request: BackupRequest = fetch,
): Promise<SystemBackupJobStatus> {
  const route = status.kind === "import" ? "import" : "export";
  let response: Response;
  try {
    response = await request(
      `/api/admin/${route}/${encodeURIComponent(status.jobId)}/advance`,
      { method: "POST", headers: systemBackupActionHeaders },
    );
  } catch (error) {
    throw new SystemBackupClientError(
      "network",
      "Связь прервалась. Серверное задание сохранено; продолжите его повторно.",
      { cause: error },
    );
  }
  return responseStatus(response, "Сервер не смог продолжить операцию.");
}

export async function runSystemBackupJob(
  initial: SystemBackupJobStatus,
  options: {
    request?: BackupRequest;
    onProgress?: BackupJobProgress;
    onConnectionState?: BackupConnectionState;
    signal?: AbortSignal;
    maximumSteps?: number;
    requestTimeoutMs?: number;
    stepDelayMs?: number;
    maximumNetworkRetries?: number;
    retryBaseDelayMs?: number;
    retryMaximumDelayMs?: number;
    leaseHeldDelayMs?: number;
  } = {},
): Promise<SystemBackupJobStatus> {
  const request = options.request ?? fetch;
  const maximumSteps = options.maximumSteps ?? 20_000;
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 25_000);
  const stepDelayMs = Math.max(0, options.stepDelayMs ?? 200);
  const maximumNetworkRetries = Math.max(0, options.maximumNetworkRetries ?? 3);
  const retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 250);
  const retryMaximumDelayMs = Math.max(retryBaseDelayMs, options.retryMaximumDelayMs ?? 4_000);
  const leaseHeldDelayMs = Math.max(0, options.leaseHeldDelayMs ?? 1_500);
  const boundedRequest: BackupRequest = async (input, init = {}) => {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      return await request(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  };
  let current = initial;
  options.onProgress?.(current);
  for (let step = 0; !backupJobIsTerminal(current) && step < maximumSteps; step += 1) {
    if (options.signal?.aborted) {
      throw new SystemBackupClientError("stopped", "Операция приостановлена в этом окне.");
    }
    if (step > 0 && stepDelayMs > 0) await backupDelay(stepDelayMs, options.signal);
    try {
      current = await advanceSystemBackupJob(current, boundedRequest);
      options.onConnectionState?.(false);
    } catch (error) {
      if (!(error instanceof SystemBackupClientError) || error.code !== "network") throw error;
      if (options.signal?.aborted) {
        throw new SystemBackupClientError("stopped", "Операция приостановлена в этом окне.");
      }
      options.onConnectionState?.(true);
      let recovered: SystemBackupJobStatus | null = null;
      let lastError: unknown = error;
      for (let retry = 0; retry <= maximumNetworkRetries; retry += 1) {
        if (retry > 0 || retryBaseDelayMs > 0) {
          const delayMs = Math.min(retryMaximumDelayMs, retryBaseDelayMs * (2 ** retry));
          await backupDelay(delayMs, options.signal);
        }
        try {
          recovered = await getBackupJobStatus(current.jobId, boundedRequest);
          break;
        } catch (statusError) {
          lastError = statusError;
          if (!(statusError instanceof SystemBackupClientError) || statusError.code !== "network") {
            throw statusError;
          }
        }
      }
      if (!recovered) throw lastError;
      current = recovered;
      options.onConnectionState?.(false);
    }
    options.onProgress?.(current);
    if (current.advanceDeferred && !backupJobIsTerminal(current) && leaseHeldDelayMs > 0) {
      await backupDelay(leaseHeldDelayMs, options.signal);
    }
  }
  if (!backupJobIsTerminal(current)) {
    throw new SystemBackupClientError(
      "stopped",
      "Операция продолжается на сервере. Нажмите «Продолжить», чтобы возобновить шаги.",
    );
  }
  return current;
}

function backupDelay(durationMs: number, signal?: AbortSignal) {
  if (durationMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new SystemBackupClientError("stopped", "Операция приостановлена в этом окне."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, durationMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function fileIdentity(file: File) {
  return { name: file.name, size: file.size, lastModified: file.lastModified };
}

function sameFile(
  file: File,
  expected: SystemBackupCheckpoint["file"],
) {
  const actual = fileIdentity(file);
  return !!expected
    && expected.name === actual.name
    && expected.size === actual.size
    && expected.lastModified === actual.lastModified;
}

async function uploadFrame(
  jobId: string,
  frame: SystemBackupFrame,
  request: BackupRequest,
  maximumAttempts: number,
): Promise<SystemBackupJobStatus> {
  const index = frame.index;
  if (!Number.isInteger(index) || (index as number) < 0) {
    throw new SystemBackupClientError("bad_file", "Backup-файл содержит неверный индекс части.");
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      const response = await request(
        `/api/admin/import/validate/${encodeURIComponent(jobId)}/parts/${index}`,
        {
          method: "PUT",
          headers: {
            ...systemBackupActionHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(frame),
        },
      );
      if (response.ok) return responseStatus(response, "Сервер не принял часть backup-файла.");
      if (response.status < 500 && response.status !== 409 && response.status !== 429) {
        return responseStatus(response, "Сервер отклонил часть backup-файла.");
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new SystemBackupClientError(
    "network",
    `Не удалось загрузить часть ${index}. Повторите загрузку — принятые части сохранятся.`,
    { cause: lastError },
  );
}

export async function uploadSystemBackupPackage(
  file: File,
  options: {
    request?: BackupRequest;
    checkpoint?: SystemBackupCheckpoint | null;
    onCheckpoint?: (checkpoint: SystemBackupCheckpoint) => void;
    onProgress?: BackupJobProgress;
    maximumUploadAttempts?: number;
    signal?: AbortSignal;
  } = {},
): Promise<SystemBackupJobStatus> {
  const request = options.request ?? fetch;
  const frames = readSystemBackupFrames(file);
  const first = await frames.next();
  if (first.done || first.value.frame !== "header") {
    throw new SystemBackupClientError("bad_file", "Backup-файл должен начинаться с header frame.");
  }

  let status: SystemBackupJobStatus;
  if (options.checkpoint) {
    if (options.checkpoint.kind !== "import" || !sameFile(file, options.checkpoint.file)) {
      throw new SystemBackupClientError(
        "bad_file",
        "Для продолжения выберите тот же backup-файл без изменений.",
      );
    }
    status = await getBackupJobStatus(options.checkpoint.jobId, request);
    if (
      status.schemaVersion !== first.value.schemaVersion
      || status.schemaFingerprint !== first.value.schemaFingerprint
      || status.exportedAt !== first.value.exportedAt
    ) {
      throw new SystemBackupClientError("bad_file", "Выбранный файл не совпадает с начатым импортом.");
    }
  } else {
    let response: Response;
    try {
      response = await request("/api/admin/import/validate", {
        method: "POST",
        headers: {
          ...systemBackupActionHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify(first.value),
      });
    } catch (error) {
      throw new SystemBackupClientError(
        "network",
        "Не удалось начать проверку backup-файла.",
        { cause: error },
      );
    }
    status = await responseStatus(response, "Сервер отклонил header backup-файла.");
  }

  const checkpoint: SystemBackupCheckpoint = {
    jobId: status.jobId,
    kind: "import",
    file: fileIdentity(file),
  };
  options.onCheckpoint?.(checkpoint);
  options.onProgress?.(status);

  if (status.status !== "uploading") {
    return runSystemBackupJob(status, {
      request,
      onProgress: options.onProgress,
      signal: options.signal,
      stepDelayMs: 0,
    });
  }

  let expectedIndex = 0;
  let manifest: SystemBackupFrame | null = null;
  for await (const frame of frames) {
    if (options.signal?.aborted) {
      throw new SystemBackupClientError("stopped", "Загрузка приостановлена в этом окне.");
    }
    if (frame.frame === "header") {
      throw new SystemBackupClientError("bad_file", "Backup-файл содержит повторный header frame.");
    }
    if (frame.frame === "manifest") {
      manifest = frame;
      break;
    }
    if (frame.index !== expectedIndex) {
      throw new SystemBackupClientError(
        "bad_file",
        `Backup-файл повреждён: ожидалась часть ${expectedIndex}.`,
      );
    }
    if (expectedIndex >= status.progress.nextPartIndex) {
      status = await uploadFrame(
        status.jobId,
        frame,
        request,
        options.maximumUploadAttempts ?? 3,
      );
      options.onCheckpoint?.(checkpoint);
      options.onProgress?.(status);
    }
    expectedIndex += 1;
  }

  if (!manifest) {
    throw new SystemBackupClientError("bad_file", "Backup-файл обрывается до manifest frame.");
  }
  const extra = await frames.next();
  if (!extra.done) {
    throw new SystemBackupClientError("bad_file", "После manifest frame обнаружены лишние данные.");
  }
  if (status.progress.nextPartIndex !== expectedIndex) {
    throw new SystemBackupClientError("bad_file", "Набор загруженных частей не совпадает с manifest.");
  }

  let finalizeResponse: Response;
  try {
    finalizeResponse = await request(
      `/api/admin/import/validate/${encodeURIComponent(status.jobId)}/finalize`,
      {
        method: "POST",
        headers: {
          ...systemBackupActionHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify(manifest),
      },
    );
  } catch (error) {
    throw new SystemBackupClientError(
      "network",
      "Все части загружены, но завершить проверку не удалось. Повторите с тем же файлом.",
      { cause: error },
    );
  }
  status = await responseStatus(finalizeResponse, "Сервер отклонил manifest backup-файла.");
  options.onProgress?.(status);
  return runSystemBackupJob(status, {
    request,
    onProgress: options.onProgress,
    signal: options.signal,
    stepDelayMs: 0,
  });
}

export async function applySystemBackupImport(
  status: SystemBackupJobStatus,
  request: BackupRequest = fetch,
): Promise<SystemBackupJobStatus> {
  if (!backupImportIsFullyValidated(status)) {
    throw new SystemBackupClientError("stopped", "Импорт ещё не прошёл полную проверку.");
  }
  let response: Response;
  try {
    response = await request("/api/admin/import", {
      method: "POST",
      headers: {
        ...systemBackupActionHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        importId: status.jobId,
        sha256: status.rootSha256,
        confirmation: "RESTORE",
      }),
    });
  } catch (error) {
    throw new SystemBackupClientError(
      "network",
      "Не удалось запустить восстановление. Проверенное задание сохранено.",
      { cause: error },
    );
  }
  return responseStatus(response, "Сервер не смог запустить восстановление.");
}

export function safeBackupMessage(value: string) {
  const withoutUrls = value.replace(/https?:\/\/\S+/gi, "[адрес скрыт]");
  const withoutSecrets = withoutUrls.replace(
    /\b(?:token|secret|password|authorization|cookie|api[_-]?key)\s*[:=]\s*\S+/gi,
    "[секрет скрыт]",
  );
  return withoutSecrets.slice(0, 240);
}

export function safeSystemBackupDownloadUrl(value: string | null) {
  if (!value) return null;
  if (!/^\/api\/admin\/export\/[^/?#]+(?:\?fromPart=\d+)?$/.test(value)) return null;
  return value;
}
