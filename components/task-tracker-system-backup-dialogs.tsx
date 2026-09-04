"use client";

import {
applySystemBackupImport,
backupImportIsFullyValidated,
backupJobIsTerminal,
canApplySystemBackupImport,
createSystemBackupExport,
getBackupJobStatus,
readBackupCheckpoint,
retainBackupCheckpoint,
runSystemBackupJob,
safeBackupMessage,
safeSystemBackupDownloadUrl,
systemBackupImportCheckpointKey,
systemBackupMediaType,
systemBackupSafetyExportCheckpointKey,
uploadSystemBackupPackage,
writeBackupCheckpoint,
type SystemBackupCheckpoint,
} from "@/lib/system-backup-client";
import type {
SystemBackupJobStatus
} from "@/lib/types";
import {
Check,
Database,
Download,
RotateCw,
Upload
} from "lucide-react";
import {
FormEvent,
useCallback,
useEffect,
useRef,
useState
} from "react";

import {
DialogHeader,
Modal,
longDateTime,
} from "@/components/task-tracker-dialog-primitives";

export function browserSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
export function backupPhaseLabel(phase: string) {
  const labels: Record<string, string> = {
    freezing_d1: "Фиксация D1",
    inventory_r2: "Инвентаризация файлов",
    hash_objects: "Проверка файлов",
    build_rows: "Упаковка таблиц",
    build_object_parts: "Упаковка файлов",
    state_digest_rows: "Контрольная сумма D1",
    state_digest_objects: "Контрольная сумма R2",
    finalize_export: "Завершение экспорта",
    uploading: "Загрузка частей",
    validating_parts: "Проверка частей",
    validating_objects: "Проверка файлов",
    preflight: "Полная проверка состояния",
    revalidate_r2: "Повторная проверка R2",
    apply_revalidate_rows: "Проверка D1 перед заменой",
    apply_revalidate_objects: "Проверка R2 перед заменой",
    prepare_rollback: "Подготовка страховочного снимка",
    waiting_rollback: "Ожидание страховочного снимка",
    materializing: "Подготовка новых объектов",
    d1_cutover: "Атомарная замена D1",
    verifying_d1: "Проверка восстановленной D1",
    verification_failed: "D1 заменена, проверка не пройдена",
    verifying_objects: "Проверка восстановленного R2",
    cleanup: "Очистка прежних объектов",
    ready: "Готово",
    applied: "Восстановлено",
    failed: "Остановлено",
    expired: "Срок задания истёк",
  };
  return labels[phase] ?? "Обработка";
}

export function backupByteSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** index);
  return `${amount.toLocaleString("ru-RU", { maximumFractionDigits: index === 0 ? 0 : 1 })} ${units[index]}`;
}

export function backupOriginLabel(origin: string) {
  try {
    return new URL(origin).host;
  } catch {
    return "текущий Site";
  }
}

export function rememberBackupStatus(
  key: string,
  status: SystemBackupJobStatus,
  extra: Pick<SystemBackupCheckpoint, "file" | "relatedJobId"> = {},
) {
  const storage = browserSessionStorage();
  if (!storage) return;
  writeBackupCheckpoint(
    storage,
    key,
    retainBackupCheckpoint(status)
      ? { jobId: status.jobId, kind: status.kind, ...extra }
      : null,
  );
}

export function clearBackupStatus(key: string) {
  const storage = browserSessionStorage();
  if (storage) writeBackupCheckpoint(storage, key, null);
}

export function SystemBackupProgress({ status }: { status: SystemBackupJobStatus }) {
  return <div className="system-backup-progress" role="status" aria-live="polite">
    <span className={`system-backup-state ${status.status}`}>{backupPhaseLabel(status.phase)}</span>
    <dl>
      <div><dt>Строки</dt><dd>{status.progress.rows.toLocaleString("ru-RU")}</dd></div>
      <div><dt>Данные</dt><dd>{backupByteSize(status.progress.bytes)}</dd></div>
      <div><dt>Части</dt><dd>{status.progress.parts.toLocaleString("ru-RU")}</dd></div>
      <div><dt>Контрольная точка</dt><dd>{longDateTime(status.updatedAt)}</dd></div>
    </dl>
  </div>;
}

export function SystemBackupPreview({ status }: { status: SystemBackupJobStatus }) {
  const counts = Object.entries(status.counts).sort(([left], [right]) => left.localeCompare(right));
  const namespaces = Object.entries(status.r2.namespaces).sort(([left], [right]) => left.localeCompare(right));
  const policies = [
    ["Точно сохраняются", status.policies.exact],
    ["Перестраиваются", status.policies.rebuild],
    ["Сбрасываются", status.policies.reset],
    ["Отзываются", status.policies.revoke],
    ["Не входят", status.policies.excluded],
  ] as const;
  return <div className="system-backup-preview">
    <div className="system-import-valid"><Check size={15} /><span><b>Полная проверка пройдена</b><small>{status.exportedAt ? `Снимок от ${longDateTime(status.exportedAt)}` : "Дата снимка уточняется"}</small></span></div>
    <dl className="system-backup-metadata">
      <div><dt>Формат</dt><dd>{status.format.name} v{status.format.version}</dd></div>
      <div><dt>Схема</dt><dd>{status.schemaVersion}</dd></div>
      <div><dt>Site</dt><dd>{backupOriginLabel(status.siteOrigin)}</dd></div>
      <div><dt>Среда</dt><dd>{status.environmentScope}</dd></div>
      <div className="wide"><dt>Fingerprint схемы</dt><dd><code>{status.schemaFingerprint}</code></dd></div>
      <div className="wide"><dt>Root SHA-256</dt><dd><code>{status.rootSha256 ?? "—"}</code></dd></div>
      <div className="wide"><dt>State SHA-256</dt><dd><code>{status.stateSha256 ?? "—"}</code></dd></div>
    </dl>
    <details className="system-backup-details" open>
      <summary>Все таблицы · {counts.length}</summary>
      <dl className="system-import-counts">
        {counts.map(([name, count]) => <div key={name}><dt>{name}</dt><dd>{count.toLocaleString("ru-RU")}</dd></div>)}
      </dl>
    </details>
    <details className="system-backup-details" open>
      <summary>Файлы R2</summary>
      <dl className="system-backup-r2">
        <div><dt>Объекты</dt><dd>{status.r2.objects.toLocaleString("ru-RU")}</dd></div>
        <div><dt>Объём</dt><dd>{backupByteSize(status.r2.bytes)}</dd></div>
        <div><dt>Связанные</dt><dd>{status.r2.bound.toLocaleString("ru-RU")}</dd></div>
        <div><dt>Несвязанные</dt><dd>{status.r2.unbound.toLocaleString("ru-RU")}</dd></div>
        <div><dt>Сироты</dt><dd>{status.r2.orphan.toLocaleString("ru-RU")}</dd></div>
      </dl>
      {namespaces.length > 0 && <dl className="system-backup-namespaces">{namespaces.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value.objects.toLocaleString("ru-RU")} · {backupByteSize(value.bytes)}</dd></div>)}</dl>}
    </details>
    <details className="system-backup-details">
      <summary>Политики восстановления</summary>
      <dl className="system-backup-policies">{policies.map(([label, values]) => <div key={label}><dt>{label}</dt><dd>{values.length > 0 ? values.join(", ") : "—"}</dd></div>)}</dl>
    </details>
    {(status.rollbackJobId || status.cleanupPending || status.error) && <dl className="system-backup-operational">
      {status.rollbackJobId && <div><dt>Страховочный job</dt><dd>{status.rollbackJobId}</dd></div>}
      {status.cleanupPending && <div><dt>Очистка</dt><dd>Замена завершена; очистка прежних объектов ещё идёт.</dd></div>}
      {status.error && <div><dt>Состояние ошибки</dt><dd>{safeBackupMessage(status.error)}</dd></div>}
    </dl>}
    {status.warnings.length > 0 && <div className="system-backup-messages warning" role="status"><b>Предупреждения</b><ul>{status.warnings.map((warning, index) => <li key={`${warning}:${index}`}>{safeBackupMessage(warning)}</li>)}</ul></div>}
    {status.validationErrors.length > 0 && <div className="system-backup-messages error" role="alert"><b>Ошибки проверки</b><ul>{status.validationErrors.map((error, index) => <li key={`${error}:${index}`}>{safeBackupMessage(error)}</li>)}</ul></div>}
  </div>;
}

export function SystemBackupExportDialog({
  status,
  busy,
  waitingForNetwork,
  error,
  onClose,
  onStart,
  onResume,
}: {
  status: SystemBackupJobStatus | null;
  busy: boolean;
  waitingForNetwork: boolean;
  error: string;
  onClose: () => void;
  onStart: (fresh?: boolean) => void;
  onResume: () => void;
}) {
  const [downloadStartedForJobId, setDownloadStartedForJobId] = useState<string | null>(null);
  const downloadStarted = downloadStartedForJobId === status?.jobId;
  const downloadUrl = safeSystemBackupDownloadUrl(status?.downloadUrl ?? null);
  const terminalFailure = status?.status === "failed" || status?.status === "expired";
  const resumable = Boolean(status && !backupJobIsTerminal(status) && !busy);
  const stateLabel = status?.status === "ready"
    ? "Экспорт готов"
    : terminalFailure
      ? "Экспорт остановлен"
      : waitingForNetwork
        ? "Ожидается сеть — можно возобновить"
        : busy
          ? "Экспорт выполняется"
          : resumable
            ? "Экспорт можно возобновить"
            : "Подготовка экспорта";
  return <Modal onClose={onClose} className="system-import-modal system-export-modal">
    <DialogHeader title="Экспорт полного состояния" icon={<Download size={17} />} onClose={onClose} />
    <div className="system-import-body">
      <p>Снимок включает состояние всех пользователей, проектов, задач, представлений и оригиналы файлов. Он содержит чувствительные данные — храните его как секрет.</p>
      <div className={`system-export-runtime ${waitingForNetwork ? "waiting" : status?.status ?? "idle"}`} role="status" aria-live="polite">
        <b>{stateLabel}</b>
        <span>Пока Task Manager открыт, экспорт продолжает работу независимо от этого окна. При полностью закрытой вкладке он безопасно приостановится и продолжится после следующего открытия Administration.</span>
      </div>
      {status && <SystemBackupProgress status={status} />}
      {status?.status === "ready" && <SystemBackupPreview status={status} />}
      {error && <p className="system-import-error" role="alert">{error}</p>}
    </div>
    <div className="dialog-footer system-backup-footer">
      <span>{downloadStarted ? "Загрузка передана браузеру" : status?.status === "ready" ? "Файл готов и не кэшируется" : "Состояние задания хранится на сервере"}</span>
      <div>
        <button className="button ghost" type="button" onClick={onClose}>Закрыть окно</button>
        {!status && !busy && <button className="button primary" type="button" onClick={() => onStart()}><Download size={14} />Начать экспорт</button>}
        {terminalFailure && <button className="button ghost" type="button" disabled={busy} onClick={() => onStart()}><RotateCw size={14} />Начать заново</button>}
        {resumable && <button className="button primary" type="button" onClick={onResume}><RotateCw size={14} />Продолжить</button>}
        {status?.status === "ready" && <button className="button ghost" type="button" onClick={() => onStart(true)}><RotateCw size={14} />Новый экспорт</button>}
        {downloadUrl && <a className="button primary" href={downloadUrl} download onClick={() => setDownloadStartedForJobId(status?.jobId ?? null)}><Download size={14} />Скачать .tmbak</a>}
      </div>
    </div>
  </Modal>;
}

export function SystemImportDialog({
  onClose,
  onBusyChange,
  onApplied,
}: {
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onApplied: (result: SystemBackupJobStatus) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<SystemBackupJobStatus | null>(null);
  const [safetyStatus, setSafetyStatus] = useState<SystemBackupJobStatus | null>(null);
  const [safetyDownloaded, setSafetyDownloaded] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const booted = useRef(false);
  const safetyBootedFor = useRef<string | null>(null);

  const setImportBusy = useCallback((value: boolean) => {
    setBusy(value);
    onBusyChange(value);
  }, [onBusyChange]);

  const updateImportStatus = useCallback((next: SystemBackupJobStatus, selectedFile?: File | null) => {
    setStatus(next);
    const source = selectedFile ?? file;
    rememberBackupStatus(systemBackupImportCheckpointKey, next, source ? {
      file: { name: source.name, size: source.size, lastModified: source.lastModified },
    } : {});
  }, [file]);

  const finishResumedImport = useCallback(async (initial: SystemBackupJobStatus) => {
    setImportBusy(true);
    setError("");
    try {
      const result = await runSystemBackupJob(initial, { onProgress: updateImportStatus, stepDelayMs: 0 });
      updateImportStatus(result);
      if (result.status === "applied") {
        clearBackupStatus(systemBackupImportCheckpointKey);
        clearBackupStatus(systemBackupSafetyExportCheckpointKey);
        onApplied(result);
      } else if (result.phase === "verification_failed") {
        setError("D1 уже заменена, но post-restore проверка не прошла. Не запускайте замену повторно вслепую.");
      } else if (result.status === "failed" || result.status === "expired") {
        setError("Сервер остановил операцию до подтверждённого восстановления.");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось продолжить операцию.");
    } finally {
      setImportBusy(false);
    }
  }, [onApplied, setImportBusy, updateImportStatus]);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const storage = browserSessionStorage();
    const checkpoint = storage ? readBackupCheckpoint(storage, systemBackupImportCheckpointKey) : null;
    if (!checkpoint) return;
    void getBackupJobStatus(checkpoint.jobId).then((current) => {
      setStatus(current);
      if (current.status === "uploading") return;
      if (current.status !== "ready" && current.status !== "failed" && current.status !== "expired" && current.status !== "applied") {
        void finishResumedImport(current);
      } else if (current.status === "applied") {
        clearBackupStatus(systemBackupImportCheckpointKey);
        onApplied(current);
      }
    }).catch((requestError: unknown) => {
      clearBackupStatus(systemBackupImportCheckpointKey);
      setError(requestError instanceof Error ? requestError.message : "Сохранённый импорт недоступен.");
    });
  }, [finishResumedImport, onApplied]);

  useEffect(() => {
    if (!status || !backupImportIsFullyValidated(status) || safetyBootedFor.current === status.jobId) return;
    const importJobId = status.jobId;
    safetyBootedFor.current = importJobId;
    const storage = browserSessionStorage();
    const checkpoint = storage ? readBackupCheckpoint(storage, systemBackupSafetyExportCheckpointKey) : null;
    if (!checkpoint || checkpoint.relatedJobId !== importJobId) {
      if (checkpoint) clearBackupStatus(systemBackupSafetyExportCheckpointKey);
      return;
    }
    void getBackupJobStatus(checkpoint.jobId).then((current) => {
      setSafetyStatus(current);
      if (current.status !== "ready" && current.status !== "failed" && current.status !== "expired") {
        setImportBusy(true);
        void runSystemBackupJob(current, {
          onProgress: (next) => {
            setSafetyStatus(next);
            rememberBackupStatus(systemBackupSafetyExportCheckpointKey, next, { relatedJobId: importJobId });
          },
          stepDelayMs: 0,
        }).finally(() => setImportBusy(false));
      }
    }).catch(() => clearBackupStatus(systemBackupSafetyExportCheckpointKey));
  }, [setImportBusy, status]);

  async function validateFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setImportBusy(true);
    setError("");
    setSafetyDownloaded(false);
    setSafetyStatus(null);
    setConfirmation("");
    clearBackupStatus(systemBackupSafetyExportCheckpointKey);
    const storage = browserSessionStorage();
    const checkpoint = storage ? readBackupCheckpoint(storage, systemBackupImportCheckpointKey) : null;
    try {
      const result = await uploadSystemBackupPackage(file, {
        checkpoint,
        onCheckpoint: (next) => {
          if (storage) writeBackupCheckpoint(storage, systemBackupImportCheckpointKey, next);
        },
        onProgress: (next) => updateImportStatus(next, file),
      });
      updateImportStatus(result, file);
      if (result.status === "failed" || result.status === "expired") {
        setError("Backup не прошёл проверку. Рабочие данные не менялись.");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось проверить backup-файл.");
    } finally {
      setImportBusy(false);
    }
  }

  async function createSafetyBackup() {
    if (!status || !backupImportIsFullyValidated(status)) return;
    setImportBusy(true);
    setError("");
    setSafetyDownloaded(false);
    try {
      const created = await createSystemBackupExport(fetch, { fresh: true });
      setSafetyStatus(created);
      rememberBackupStatus(systemBackupSafetyExportCheckpointKey, created, { relatedJobId: status.jobId });
      const result = await runSystemBackupJob(created, {
        onProgress: (next) => {
          setSafetyStatus(next);
          rememberBackupStatus(systemBackupSafetyExportCheckpointKey, next, { relatedJobId: status.jobId });
        },
        stepDelayMs: 0,
      });
      setSafetyStatus(result);
      rememberBackupStatus(systemBackupSafetyExportCheckpointKey, result, { relatedJobId: status.jobId });
      if (result.status !== "ready") setError("Не удалось подготовить текущий страховочный снимок.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось подготовить текущий backup.");
    } finally {
      setImportBusy(false);
    }
  }

  async function applyImport() {
    if (!status || !canApplySystemBackupImport(status, safetyDownloaded, confirmation)) return;
    setImportBusy(true);
    setError("");
    try {
      const applying = await applySystemBackupImport(status);
      updateImportStatus(applying);
      const result = await runSystemBackupJob(applying, { onProgress: updateImportStatus, stepDelayMs: 0 });
      updateImportStatus(result);
      if (result.status !== "applied") {
        setError(result.phase === "verification_failed"
          ? "D1 уже заменена, но post-restore проверка не прошла. Не запускайте замену повторно вслепую."
          : "Восстановление не подтверждено сервером как завершённое.");
        return;
      }
      clearBackupStatus(systemBackupImportCheckpointKey);
      clearBackupStatus(systemBackupSafetyExportCheckpointKey);
      onApplied(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось завершить восстановление.");
    } finally {
      setImportBusy(false);
    }
  }

  function chooseAnotherFile() {
    clearBackupStatus(systemBackupImportCheckpointKey);
    clearBackupStatus(systemBackupSafetyExportCheckpointKey);
    setStatus(null);
    setSafetyStatus(null);
    setSafetyDownloaded(false);
    setConfirmation("");
    setFile(null);
    setError("");
  }

  const validated = backupImportIsFullyValidated(status);
  const committedVerificationFailure = status?.phase === "verification_failed";
  const safetyUrl = safeSystemBackupDownloadUrl(safetyStatus?.downloadUrl ?? null);
  return <Modal onClose={() => !busy && onClose()} className="system-import-modal">
    <DialogHeader title="Импорт полного состояния" icon={<Upload size={17} />} onClose={() => !busy && onClose()} />
    {!validated ? <form onSubmit={validateFile}>
      <div className="system-import-body">
        <p>{committedVerificationFailure
          ? "Атомарная замена D1 уже выполнена, но post-restore проверка обнаружила расхождение. Повторный apply не выполняйте до разбора причины."
          : "Импорт полностью заменит состояние всех пользователей. До завершения проверки сервер не меняет рабочие таблицы и файлы."}</p>
        {status && <SystemBackupProgress status={status} />}
        {status?.status === "uploading" && !file && <div className="system-backup-resume"><RotateCw size={14} /><span>Незавершённая загрузка найдена. Выберите тот же файл — уже принятые части повторно не отправятся.</span></div>}
        {!committedVerificationFailure && <label className="system-import-file">
          <span>Файл полного backup</span>
          <input
            type="file"
            accept={`.tmbak,${systemBackupMediaType}`}
            required
            disabled={busy}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setError("");
            }}
          />
          <small>Файл читается построчно; общий размер не ограничен 10 МБ.</small>
        </label>}
        {status && (status.validationErrors.length > 0 || status.warnings.length > 0 || status.error) && <SystemBackupPreview status={status} />}
        {error && <p className="system-import-error" role="alert">{error}</p>}
      </div>
      <div className="dialog-footer system-backup-footer">
        <span>{committedVerificationFailure
          ? "D1 replace уже committed; сохраните diagnostics ошибки проверки"
          : "Повреждённый или неполный файл не меняет live state"}</span>
        <div>
          {committedVerificationFailure
            ? <button className="button primary" type="button" onClick={onClose}>Закрыть</button>
            : <>
                {status && (status.status === "uploading" || status.status === "failed" || status.status === "expired") && <button className="button ghost" type="button" disabled={busy} onClick={chooseAnotherFile}>Сбросить загрузку</button>}
                <button className="button primary" disabled={!file || busy}>{busy ? "Проверяем…" : status?.status === "uploading" ? "Продолжить проверку" : "Загрузить и проверить"}</button>
              </>}
        </div>
      </div>
    </form> : <div>
      <div className="system-import-body">
        {status && <SystemBackupPreview status={status} />}
        <div className="system-import-warning">
          <b>Следующий шаг заменит всё рабочее состояние.</b>
          <span>Сначала создайте и скачайте новый снимок текущего Site. Замена выполняется целиком; частичного восстановления нет.</span>
        </div>
        {!safetyStatus && <button className="button secondary system-import-download" type="button" disabled={busy} onClick={() => void createSafetyBackup()}><Database size={14} />Создать текущий backup</button>}
        {safetyStatus && <SystemBackupProgress status={safetyStatus} />}
        {safetyUrl && <a className={`button secondary system-import-download ${safetyDownloaded ? "confirmed" : ""}`} href={safetyUrl} download onClick={() => setSafetyDownloaded(true)}>{safetyDownloaded ? <Check size={14} /> : <Download size={14} />}{safetyDownloaded ? "Скачивание текущего backup запущено" : "Скачать текущий backup"}</a>}
        <label className="system-import-confirmation">
          <span>Введите <b>RESTORE</b>, чтобы заменить состояние</span>
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy} />
        </label>
        {error && <p className="system-import-error" role="alert">{error}</p>}
      </div>
      <div className="dialog-footer system-backup-footer">
        <button className="button ghost" type="button" disabled={busy} onClick={chooseAnotherFile}>Другой файл</button>
        <button className="button primary system-import-apply" type="button" disabled={busy || !canApplySystemBackupImport(status, safetyDownloaded, confirmation)} onClick={() => void applyImport()}>{busy ? "Восстанавливаем…" : "Заменить всё состояние"}</button>
      </div>
    </div>}
  </Modal>;
}
