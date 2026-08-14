"use client";
/* eslint-disable @next/next/no-html-link-for-pages */

import { useEffect, useMemo, useState } from "react";
import type { AppSnapshot, AppliedLinearMigration, LinearMigrationPreview } from "@/lib/types";
import type { LinearInventory } from "@/lib/linear-oauth";

type SessionInventory = LinearInventory & { status: string; preview: LinearMigrationPreview | null };

export function LinearImporter() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [inventory, setInventory] = useState<SessionInventory | null>(null);
  const [app, setApp] = useState<AppSnapshot | null>(null);
  const [mode, setMode] = useState<"workspace" | "projects" | "assignees">("workspace");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [preview, setPreview] = useState<LinearMigrationPreview | null>(null);
  const [applied, setApplied] = useState<AppliedLinearMigration | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sessionId = useMemo(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("session") ?? "", []);

  useEffect(() => {
    void Promise.all([
      fetch(`/api/import/linear/session${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`).then((response) => response.json().then((value) => ({ response, value: value as Record<string, unknown> }))),
      fetch("/api/bootstrap").then((response) => response.json().then((value) => ({ response, value: value as Record<string, unknown> }))),
    ]).then(([linear, bootstrap]) => {
      if (!linear.response.ok || linear.value.error) throw new Error(typeof linear.value.error === "string" ? linear.value.error : "Could not load Linear migration");
      if (!bootstrap.response.ok || bootstrap.value.error) throw new Error(typeof bootstrap.value.error === "string" ? bootstrap.value.error : "Could not load users");
      setConfigured(linear.value.configured === true);
      if (linear.value.inventory && typeof linear.value.inventory === "object") {
        const value = linear.value.inventory as SessionInventory;
        setInventory(value);
        if (value.preview) {
          setPreview(value.preview);
          setMode(value.preview.scope.mode);
          setSelected(new Set(value.preview.scope.ids));
        }
      }
      setApp(bootstrap.value as AppSnapshot);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load Linear migration"));
  }, [sessionId]);

  function toggle(id: string) {
    setPreview(null);
    setConfirmation("");
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function buildPreview() {
    if (!inventory) return;
    setBusy(true); setError(""); setPreview(null); setApplied(null);
    try {
      const response = await fetch("/api/import/linear/preview", {
        method: "POST",
        headers: { "content-type": "application/json", "x-task-manager-action": "linear-import" },
        body: JSON.stringify({ sessionId: inventory.sessionId, scope: { mode, ids: [...selected] }, userMapping: mapping }),
      });
      const value = await response.json() as LinearMigrationPreview | { error: string };
      if (!response.ok || "error" in value) throw new Error("error" in value ? value.error : "Linear preview failed");
      setPreview(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Linear preview failed"); }
    finally { setBusy(false); }
  }

  async function apply() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/import/linear", {
        method: "POST",
        headers: { "content-type": "application/json", "x-task-manager-action": "linear-import" },
        body: JSON.stringify({ importId: preview.importId, sha256: preview.sha256, confirmation }),
      });
      const value = await response.json() as AppliedLinearMigration | { error: string };
      if (!response.ok || "error" in value) throw new Error("error" in value ? value.error : "Linear import failed");
      setApplied(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Linear import failed"); }
    finally { setBusy(false); }
  }

  const scopeOptions = mode === "projects" ? inventory?.projects ?? [] : inventory?.users.filter((user) => user.active) ?? [];
  return (
    <main className="import-shell"><section className="import-card portability-card">
      <div><span className="eyebrow">ONE-TIME MIGRATION</span><h1>Import from Linear</h1><p>Authorize read-only access, choose workspace/projects/assignees, review, and apply atomically.</p></div>
      {configured === null && !error && <p>Checking Linear configuration…</p>}
      {configured === false && <section className="import-step"><h2>Linear OAuth is not configured</h2><p>Add the hosted <code>LINEAR_CLIENT_ID</code> and register this Site callback before connecting.</p></section>}
      {configured && !inventory && <section className="import-step"><h2>1. Connect Linear</h2><p>Task Manager requests only <code>read</code>. The token is revoked after the bounded snapshot.</p><a className="button primary" href="/api/import/linear/connect">Connect Linear</a></section>}
      {inventory && !applied && <>
        <section className="import-step"><h2>1. Connected</h2><div className="connected-source"><span><b>{inventory.organization.name}</b><small>{inventory.viewer.name} · {inventory.viewer.email}</small></span><span className="status-badge">snapshot ready</span></div><dl className="mini-counts">{Object.entries(inventory.counts).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></section>
        <section className="import-step"><h2>2. Choose scope</h2><div className="scope-tabs">{(["workspace", "projects", "assignees"] as const).map((value) => <button key={value} className={mode === value ? "active" : ""} onClick={() => { setMode(value); setSelected(new Set()); setPreview(null); }}>{value}</button>)}</div>{mode === "workspace" ? <p>Import every issue visible to this Linear account.</p> : <div className="scope-list">{scopeOptions.map((option) => <label key={option.id}><input type="checkbox" checked={selected.has(option.id)} onChange={() => toggle(option.id)} /><span><b>{option.name}</b>{"email" in option && <small>{option.email}</small>}</span></label>)}</div>}</section>
        <section className="import-step"><h2>3. Map assignees</h2><p>The connected Linear user maps to you by default. Everyone else remains unassigned unless explicitly mapped to an existing user with project access.</p><div className="mapping-list">{inventory.users.filter((user) => user.id !== inventory.viewer.id).map((user) => <label key={user.id}><span><b>{user.name}</b><small>{user.email}</small></span><select value={mapping[user.id] ?? ""} onChange={(event) => { setMapping((current) => ({ ...current, [user.id]: event.target.value || null })); setPreview(null); setConfirmation(""); }}><option value="">Unassigned</option>{app?.users.map((target) => <option key={target.id} value={target.id}>{target.displayName} · {target.email}</option>)}</select></label>)}</div><button className="button primary" disabled={busy || (mode !== "workspace" && selected.size === 0)} onClick={() => void buildPreview()}>{busy ? "Building preview…" : preview ? "Refresh preview" : "Build preview"}</button></section>
      </>}
      {error && <p className="import-error" role="alert">{error}</p>}
      {preview && !applied && <section className="import-report"><div><h2>4. Review and import</h2><p>{preview.changes.create} create · {preview.changes.update} update · {preview.mappedUsers} mapped user(s)</p></div><dl>{Object.entries(preview.counts).filter(([, value]) => value > 0).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>{preview.unmappedUsers.length > 0 && <p>{preview.unmappedUsers.length} selected Linear assignee(s) will remain unassigned.</p>}{preview.warnings.length > 0 && <ul className="import-warnings">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}<label><span>Type <b>IMPORT</b> to confirm</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><button className="button primary" disabled={busy || confirmation !== "IMPORT"} onClick={() => void apply()}>{busy ? "Importing…" : "Import from Linear"}</button></section>}
      {applied && <section className="import-report"><h2>Import complete</h2><p>The staged migration was applied atomically.</p><dl>{Object.entries(applied.counts).filter(([, value]) => value > 0).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl><a className="button primary" href="/">Open Task Manager</a></section>}
      <a className="button ghost" href="/import">Back to import &amp; export</a>
    </section></main>
  );
}
