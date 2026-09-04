"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  backupJobIsTerminal,
  createSystemBackupExport,
  getCurrentSystemBackupExport,
  runSystemBackupJob,
  SystemBackupClientError,
} from "@/lib/system-backup-client";
import type { SystemBackupJobStatus } from "@/lib/types";

export function useSystemExportController({
  enabled,
  onOpenDialog,
}: {
  enabled: boolean;
  onOpenDialog: () => void;
}) {
  const [status, setStatus] = useState<SystemBackupJobStatus | null>(null);
  const statusRef = useRef<SystemBackupJobStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [waitingForNetwork, setWaitingForNetwork] = useState(false);
  const [error, setError] = useState("");
  const flightRef = useRef<Promise<void> | null>(null);
  const startFlightRef = useRef<Promise<void> | null>(null);
  const discoveryFlightRef = useRef<Promise<SystemBackupJobStatus | null | undefined> | null>(null);
  const driveRef = useRef<(nextStatus: SystemBackupJobStatus) => Promise<void>>(
    async () => undefined,
  );
  const abortRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const discoveryStartedRef = useRef(false);
  const mountedRef = useRef(true);

  const updateStatus = useCallback((next: SystemBackupJobStatus | null) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const drive = useCallback((initial: SystemBackupJobStatus) => {
    if (backupJobIsTerminal(initial)) {
      updateStatus(initial);
      return Promise.resolve();
    }
    if (flightRef.current) return flightRef.current;
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setWaitingForNetwork(false);
    setError("");
    const operation = runSystemBackupJob(initial, {
      signal: controller.signal,
      requestTimeoutMs: 25_000,
      stepDelayMs: 250,
      maximumNetworkRetries: 3,
      retryBaseDelayMs: 500,
      retryMaximumDelayMs: 4_000,
      onConnectionState: setWaitingForNetwork,
      onProgress: updateStatus,
    }).then((result) => {
      updateStatus(result);
      if (result.status === "failed" || result.status === "expired") {
        setError("Экспорт остановлен до готового файла. Начните новый экспорт.");
      }
    }).catch((requestError: unknown) => {
      if (!mountedRef.current || controller.signal.aborted) return;
      const resumable = requestError instanceof SystemBackupClientError &&
        (requestError.code === "network" || requestError.code === "stopped");
      setWaitingForNetwork(resumable);
      setError(resumable
        ? "Сейчас нет устойчивой связи. Серверное задание сохранено и будет продолжено в этой вкладке."
        : requestError instanceof Error
          ? requestError.message
          : "Не удалось продолжить экспорт.");
      const current = statusRef.current;
      if (resumable && current && !backupJobIsTerminal(current)) {
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          const saved = statusRef.current;
          if (saved && !backupJobIsTerminal(saved)) void driveRef.current(saved);
        }, 5_000);
      }
    }).finally(() => {
      if (flightRef.current === operation) flightRef.current = null;
      if (abortRef.current === controller) abortRef.current = null;
      if (mountedRef.current) setRunning(false);
    });
    flightRef.current = operation;
    return operation;
  }, [updateStatus]);
  useEffect(() => {
    driveRef.current = drive;
  }, [drive]);

  const start = useCallback((fresh = false) => {
    if (startFlightRef.current) return startFlightRef.current;
    setRunning(true);
    setWaitingForNetwork(false);
    setError("");
    const operation = createSystemBackupExport(fetch, { fresh }).then(async (created) => {
      updateStatus(created);
      await drive(created);
    }).catch((requestError: unknown) => {
      if (!mountedRef.current) return;
      setWaitingForNetwork(
        requestError instanceof SystemBackupClientError && requestError.code === "network",
      );
      setError(requestError instanceof Error ? requestError.message : "Не удалось начать экспорт.");
    }).finally(() => {
      if (startFlightRef.current === operation) startFlightRef.current = null;
      if (mountedRef.current && !flightRef.current) setRunning(false);
    });
    startFlightRef.current = operation;
    return operation;
  }, [drive, updateStatus]);

  const discoverCurrent = useCallback(() => {
    if (discoveryFlightRef.current) return discoveryFlightRef.current;
    const operation = getCurrentSystemBackupExport().then((current) => {
      if (!mountedRef.current) return current;
      updateStatus(current);
      setWaitingForNetwork(false);
      setError("");
      if (current && !backupJobIsTerminal(current)) void drive(current);
      return current;
    }).catch((requestError: unknown) => {
      if (mountedRef.current) {
        setWaitingForNetwork(
          requestError instanceof SystemBackupClientError && requestError.code === "network",
        );
        setError(requestError instanceof Error
          ? requestError.message
          : "Не удалось проверить незавершённый экспорт.");
      }
      return undefined;
    }).finally(() => {
      if (discoveryFlightRef.current === operation) discoveryFlightRef.current = null;
    });
    discoveryFlightRef.current = operation;
    return operation;
  }, [drive, updateStatus]);

  const open = useCallback(() => {
    onOpenDialog();
    const current = statusRef.current;
    if (current?.status === "failed" || current?.status === "expired") {
      void start();
      return;
    }
    if (current) {
      if (!backupJobIsTerminal(current)) void drive(current);
      return;
    }
    void discoverCurrent().then((discovered) => {
      if (discovered === null && mountedRef.current) void start();
    });
  }, [discoverCurrent, drive, onOpenDialog, start]);

  const resume = useCallback(() => {
    const current = statusRef.current;
    if (current && !backupJobIsTerminal(current)) void drive(current);
  }, [drive]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!enabled || discoveryStartedRef.current) return;
    discoveryStartedRef.current = true;
    void discoverCurrent();
  }, [discoverCurrent, enabled]);

  return {
    status,
    running,
    waitingForNetwork,
    error,
    active: running || Boolean(status && !backupJobIsTerminal(status)),
    open,
    start,
    resume,
  };
}
