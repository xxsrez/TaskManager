"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import type { LinearImportReport } from "@/lib/linear-import";

type JsonObject = Record<string, unknown>;

export function LinearImporter() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<LinearImportReport | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setReport(null);
    try {
      const values = new FormData(event.currentTarget);
      const sourceFile = values.get("source");
      const commentsFile = values.get("comments");
      if (!(sourceFile instanceof File) || !(commentsFile instanceof File)) {
        throw new Error("Select both Linear snapshot files.");
      }
      const source = JSON.parse(await sourceFile.text()) as JsonObject;
      const comments = JSON.parse(await commentsFile.text()) as JsonObject;
      const commentsByIssue = comments.commentsByIssue;
      if (!commentsByIssue || typeof commentsByIssue !== "object") {
        throw new Error("The comments snapshot is invalid.");
      }
      const response = await fetch("/api/import/linear", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...source, commentsByIssue }),
      });
      const result = (await response.json()) as
        | LinearImportReport
        | { error: string };
      if (!response.ok || "error" in result) {
        throw new Error("error" in result ? result.error : "Import failed.");
      }
      setReport(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="import-shell">
      <section className="import-card">
        <div>
          <span className="eyebrow">TASK MANAGER</span>
          <h1>Import from Linear</h1>
          <p>
            Import an inventory snapshot and its comment archive. Repeating the
            same import updates matching Linear records without duplicating them.
          </p>
        </div>
        <form onSubmit={submit}>
          <label>
            <span>Workspace snapshot</span>
            <input name="source" type="file" accept="application/json,.json" required />
          </label>
          <label>
            <span>Comments snapshot</span>
            <input name="comments" type="file" accept="application/json,.json" required />
          </label>
          <button className="button primary" disabled={busy}>
            {busy ? "Importing…" : "Import workspace"}
          </button>
        </form>
        {error && <p className="import-error" role="alert">{error}</p>}
        {report && (
          <section className="import-report" aria-live="polite">
            <h2>Import complete</h2>
            <dl>
              {Object.entries(report).map(([label, value]) => (
                <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
              ))}
            </dl>
            <Link className="button secondary" href="/">Open Task Manager</Link>
          </section>
        )}
      </section>
    </main>
  );
}
