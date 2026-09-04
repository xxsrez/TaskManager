"use client";

import {
nextCodexSetupMode,
TASK_MANAGER_CLI_SETUP,
TASK_MANAGER_DIAGNOSTIC_PROMPT,
TASK_MANAGER_MARKETPLACE_URL,
type CodexSetupMode
} from "@/components/task-tracker-state";
import {
Check,
CircleHelp,
Copy
} from "lucide-react";
import {
useState
} from "react";

import { DialogHeader,Modal } from "@/components/task-tracker-dialog-primitives";

export function CodexSetupDialog({ onClose, initialMode = "desktop", embedded = false }: { onClose: () => void; initialMode?: CodexSetupMode; embedded?: boolean }) {
  const [mode, setMode] = useState<CodexSetupMode>(initialMode);
  const [copied, setCopied] = useState<"marketplace" | "commands" | "diagnostic" | null>(null);

  function selectCodexSetupMode(nextMode: CodexSetupMode) {
    setMode((currentMode) => nextCodexSetupMode(currentMode, { type: "select", mode: nextMode }));
    setCopied(null);
  }

  function openCodexCliFallback() {
    setMode((currentMode) => nextCodexSetupMode(currentMode, { type: "open_cli_fallback" }));
    setCopied(null);
  }

  async function copySetup(value: string, target: "marketplace" | "commands" | "diagnostic") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
    } catch {
      setCopied(null);
    }
  }

  const body = <>
      {!embedded && <DialogHeader title="Connect Task Manager to Codex" icon={<CircleHelp size={17} />} onClose={onClose} />}
      <div className="codex-setup-body">
        <aside className="codex-mobile-handoff">
          <b>Installing from a phone?</b>
          <span>Continue on ChatGPT/Codex Desktop or with Codex CLI. Mobile ChatGPT can use Task Manager after the plugin is installed on the same account.</span>
        </aside>
        <p className="codex-setup-intro">
          Adding the marketplace, installing the plugin, and connecting your Task Manager account are separate checkpoints. Complete each success check before continuing.
        </p>
        <div className="codex-setup-tabs" role="tablist" aria-label="Codex client">
          <button
            id="codex-setup-tab-desktop"
            type="button"
            role="tab"
            aria-selected={mode === "desktop"}
            aria-controls="codex-setup-desktop"
            className={mode === "desktop" ? "active" : ""}
            onClick={() => selectCodexSetupMode("desktop")}
          >
            Codex Desktop
          </button>
          <button
            id="codex-setup-tab-cli"
            type="button"
            role="tab"
            aria-selected={mode === "cli"}
            aria-controls="codex-setup-cli"
            className={mode === "cli" ? "active" : ""}
            onClick={() => selectCodexSetupMode("cli")}
          >
            Codex CLI
          </button>
        </div>

        {mode === "desktop" ? (
          <section id="codex-setup-desktop" role="tabpanel" aria-labelledby="codex-setup-tab-desktop">
            <ol className="codex-setup-steps">
              <SetupStep
                number={1}
                title="Add Srez Marketplace"
                location="Codex Desktop · Plugins"
                success="Srez Marketplace is visible under Personal."
              >
                Open <b>Plugins → Add → Add a marketplace</b>, then paste this address into <b>Source</b>:
                <SetupCopyBlock
                  value={TASK_MANAGER_MARKETPLACE_URL}
                  label="Copy marketplace address"
                  copied={copied === "marketplace"}
                  onCopy={() => void copySetup(TASK_MANAGER_MARKETPLACE_URL, "marketplace")}
                />
                Leave <b>Git ref</b> and <b>Sparse paths</b> empty, then choose <b>Add marketplace</b>.
              </SetupStep>
              <SetupStep
                number={2}
                title="Install Task Manager plugin"
                location="Codex Desktop · Plugins → Personal"
                success="Task Manager appears under Installed."
              >
                <b>Personal</b> contains personal marketplaces. Open <b>Srez Marketplace → Task Manager</b>, then choose <b>Install</b> once.
              </SetupStep>
              <SetupStep
                number={3}
                title="Authenticate / Connect Task Manager account"
                location="Codex Desktop + browser"
                success="Task Manager consent completes; return to Codex for the Installed check."
              >
                Choose <b>Authenticate</b> or <b>Connect</b>. In the browser, confirm you are signed in to the same ChatGPT account and workspace as Desktop. On the Task Manager consent page, check the account and choose <b>Connect</b>.
              </SetupStep>
              <SetupStep
                number={4}
                title="Return to Codex and open Installed"
                location="Codex Desktop · Plugins → Installed"
                success="Installed shows Task Manager present and enabled."
              >
                Return to Desktop yourself if the browser remains open. <b>Installed</b> is where already installed plugins are checked; confirm <b>Task Manager</b> is present and enabled there.
              </SetupStep>
              <SetupStep
                number={5}
                title="Start a new task and run smoke"
                location="Codex Desktop · New task"
                success="Codex returns your Task Manager task summaries without making a write."
              >
                Start a <b>New task</b> so Codex loads the new plugin snapshot, then ask: <q>Show my tasks in Task Manager.</q> A successful response proves the account connection. Do not start a bulk migration or write flow before this read check passes.
              </SetupStep>
            </ol>

            <details className="codex-setup-troubleshooting">
              <summary>Redirected to web ChatGPT, but Task Manager is not installed?</summary>
              <div>
                <p><b>Stop after one failed Install attempt.</b> Repeated clicks do not add diagnostic information.</p>
                <ol>
                  <li>Confirm the browser and Desktop use the same ChatGPT account and workspace.</li>
                  <li>Back in Desktop, check <b>Plugins → Personal</b> for Srez Marketplace and <b>Plugins → Installed</b> for Task Manager.</li>
                  <li>Restart Desktop once, then check <b>Personal</b> and <b>Installed</b> again.</li>
                  <li>Use the Codex CLI fallback below if the plugin is still missing.</li>
                </ol>
                <button className="button secondary codex-cli-fallback" type="button" onClick={openCodexCliFallback}>
                  Open CLI fallback
                </button>
                <p>If it still fails, give an agent this bounded diagnostic prompt:</p>
                <SetupCopyBlock
                  value={TASK_MANAGER_DIAGNOSTIC_PROMPT}
                  label="Copy diagnostic prompt"
                  copied={copied === "diagnostic"}
                  multiline
                  onCopy={() => void copySetup(TASK_MANAGER_DIAGNOSTIC_PROMPT, "diagnostic")}
                />
                <p className="codex-install-bug-boundary">These checks do not fix the platform install redirect bug. They identify the failed stage and produce a reproducible report without exposing credentials.</p>
              </div>
            </details>
          </section>
        ) : (
          <section id="codex-setup-cli" role="tabpanel" aria-labelledby="codex-setup-tab-cli">
            <p className="codex-cli-copy-intro">Copy the complete fallback sequence, then verify each stage below:</p>
            <SetupCopyBlock
              value={TASK_MANAGER_CLI_SETUP}
              label="Copy CLI commands"
              copied={copied === "commands"}
              multiline
              onCopy={() => void copySetup(TASK_MANAGER_CLI_SETUP, "commands")}
            />
            <ol className="codex-setup-steps">
              <SetupStep
                number={1}
                title="Add Srez Marketplace"
                location="Terminal"
                success="codex plugin marketplace list includes Srez Marketplace."
              >
                Run <code>codex plugin marketplace add xxsrez/marketplace</code>.
              </SetupStep>
              <SetupStep
                number={2}
                title="Install Task Manager plugin"
                location="Terminal"
                success="codex plugin list includes task-manager@srez-marketplace."
              >
                Run <code>codex plugin add task-manager@srez-marketplace</code>.
              </SetupStep>
              <SetupStep
                number={3}
                title="Authenticate / Connect Task Manager account"
                location="Codex CLI + browser"
                success="Task Manager no longer shows an Authenticate action."
              >
                Run <code>codex</code>, then open <code>/plugins → Task Manager → Authenticate</code>. In the browser, use the same ChatGPT account/workspace, check the Task Manager consent, and choose <b>Connect</b>.
              </SetupStep>
              <SetupStep
                number={4}
                title="Return to Codex and start a new task"
                location="Codex CLI"
                success="A fresh task opens with the installed plugin snapshot."
              >
                Return to Codex and enter <code>/new</code>.
              </SetupStep>
              <SetupStep
                number={5}
                title="Run the read smoke"
                location="Fresh Codex task"
                success="Codex returns Task Manager task summaries without making a write."
              >
                Ask: <q>Show my tasks in Task Manager.</q> Only after this passes should you consider creating one test Task; do not begin with a bulk migration.
              </SetupStep>
            </ol>
          </section>
        )}

        <p className="codex-setup-note">
          Developer mode, a manual MCP URL, client ID, secret, and personal API token are not required for normal setup.
        </p>
      </div>
    </>;
  return embedded
    ? <section className="settings-integration" aria-label="Connect Task Manager to Codex">{body}</section>
    : <Modal onClose={onClose} className="codex-setup-modal" ariaLabel="Connect Task Manager to Codex">{body}</Modal>;
}
export function SetupStep({ number, title, location, success, children }: { number: number; title: string; location: string; success: string; children: React.ReactNode }) {
  return <li data-setup-stage={number}><span className="codex-step-number">{number}</span><div><strong>{title}</strong><span className="codex-step-location">{location}</span><div className="codex-step-content">{children}</div><p className="codex-step-success"><Check size={13} aria-hidden="true" /> <span><b>Success:</b> {success}</span></p></div></li>;
}

export function SetupCopyBlock({ value, label, copied, multiline = false, onCopy }: { value: string; label: string; copied: boolean; multiline?: boolean; onCopy: () => void }) {
  return (
    <div className={`codex-copy-block ${multiline ? "multiline" : ""}`}>
      {multiline ? <pre><code>{value}</code></pre> : <code>{value}</code>}
      <button type="button" aria-label={label} title={label} onClick={onCopy}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
