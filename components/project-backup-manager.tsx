"use client";
/* eslint-disable @next/next/no-html-link-for-pages */

import { ChangeEvent, useEffect, useState } from "react";
import type { AppliedProjectBackup, AppSnapshot, ProjectBackupPreview, ProjectRecord } from "@/lib/types";

export function ProjectBackupManager() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [preview, setPreview] = useState<ProjectBackupPreview | null>(null);
  const [applied, setApplied] = useState<AppliedProjectBackup | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [restoreSharing, setRestoreSharing] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/bootstrap").then(async (response) => {
      const value = await response.json() as AppSnapshot | { error: string };
      if (!response.ok || "error" in value) throw new Error("error" in value ? value.error : "Could not load projects");
      setSnapshot(value);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load projects"));
  }, []);

  async function download(project: ProjectRecord) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/export`, { method: "POST", headers: { "x-task-manager-action": "project-backup" } });
      if (!response.ok) throw new Error(await responseError(response, "Could not export project"));
      const blob = await response.blob();
      const filename = (response.headers.get("content-disposition") ?? "").match(/filename="([^"]+)"/)?.[1] ?? "task-manager-project.json";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      if (preview?.projectId === project.id) setDownloaded(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not export project"); }
    finally { setBusy(false); }
  }

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true); setError(""); setPreview(null); setApplied(null); setDownloaded(false); setConfirmation("");
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const response = await fetch("/api/import/project/validate", {
        method: "POST",
        headers: { "content-type": "application/json", "x-task-manager-action": "project-backup" },
        body: JSON.stringify(payload),
      });
      const value = await response.json() as ProjectBackupPreview | { error: string };
      if (!response.ok || "error" in value) throw new Error("error" in value ? value.error : "Project backup validation failed");
      setPreview(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Project backup validation failed"); }
    finally { setBusy(false); }
  }

  async function apply() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/import/project", {
        method: "POST",
        headers: { "content-type": "application/json", "x-task-manager-action": "project-backup" },
        body: JSON.stringify({ importId: preview.importId, sha256: preview.sha256, confirmation, currentBackupDownloaded: downloaded, restoreSharing }),
      });
      const value = await response.json() as AppliedProjectBackup | { error: string };
      if (!response.ok || "error" in value) throw new Error("error" in value ? value.error : "Project restore failed");
      setApplied(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Project restore failed"); }
    finally { setBusy(false); }
  }

  const owned = snapshot?.projects.filter((project) => project.accessRole === "owner") ?? [];
  const currentProject = preview ? owned.find((project) => project.id === preview.projectId) : null;
  return (
    <main className="import-shell"><section className="import-card portability-card">
      <div><span className="eyebrow">PROJECT PORTABILITY</span><h1>Project backup</h1><p>Download an owner-only bundle or restore the exact project on this Site.</p></div>
      <section className="import-step"><h2>Export</h2>{!snapshot ? <p>Loading projects…</p> : owned.length ? <div className="project-backup-list">{owned.map((project) => <div key={project.id}><span><b>{project.name}</b><small>{project.id}</small></span><button className="button secondary" disabled={busy} onClick={() => void download(project)}>Download</button></div>)}</div> : <p>You do not currently own a project.</p>}</section>
      <section className="import-step"><h2>Restore</h2><label className="file-drop"><span>Select project bundle</span><input type="file" accept="application/json,.json" onChange={(event) => void selectFile(event)} disabled={busy} /></label></section>
      {error && <p className="import-error" role="alert">{error}</p>}
      {preview && !applied && <section className="import-report">
        <div><h2>{preview.projectName}</h2><p>{preview.projectExists ? "Exact replace of the current project" : "Recreate the deleted project"}</p><small>{preview.projectId} · exported {new Date(preview.exportedAt).toLocaleString()}</small></div>
        <dl>{Object.entries(preview.counts).filter(([, value]) => value > 0).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
        <ul className="import-warnings">{Object.entries(preview.changes).filter(([, change]) => change.create + change.update + change.delete > 0).map(([name, change]) => <li key={name}>{name}: {change.create} create, {change.update} update, {change.delete} delete</li>)}</ul>
        {preview.warnings.length > 0 && <ul className="import-warnings">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        {preview.projectExists && currentProject && <button className="button secondary" disabled={busy} onClick={() => void download(currentProject)}>{downloaded ? "Current backup downloaded" : "Download current backup"}</button>}
        {preview.sharing.length > 0 && <label className="check-row"><input type="checkbox" checked={restoreSharing} onChange={(event) => setRestoreSharing(event.target.checked)} />Restore {preview.sharing.length} project participant(s)</label>}
        <label><span>Type <b>{preview.projectName}</b> to confirm</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <button className="button danger" disabled={busy || confirmation !== preview.projectName || (preview.projectExists && !downloaded)} onClick={() => void apply()}>{busy ? "Restoring…" : "Restore project"}</button>
      </section>}
      {applied && <section className="import-report"><h2>Project restored</h2><p>{applied.projectName} was applied atomically.</p><a className="button primary" href="/projects">Open Task Manager</a></section>}
      <a className="button ghost" href="/">Back to Task Manager</a>
    </section></main>
  );
}

async function responseError(response: Response, fallback: string) {
  const value = await response.json().catch(() => null) as { error?: string } | null;
  return value?.error ?? fallback;
}
