"use client";

import {
ProjectBackupManager,
} from "@/components/project-backup-manager";
import {
RecentlyDeletedManager,
} from "@/components/recently-deleted-manager";
import {
type SettingsSection
} from "@/lib/navigation";
import type {
AppSnapshot,
LabelGroupRecord,
LabelRecord,
UserProfile,
WorkflowStatusRecord
} from "@/lib/types";
import {
CircleHelp,
Database,
LogOut,
Monitor,
Moon,
Palette,
PanelLeftClose,
PanelLeftOpen,
SlidersHorizontal,
Sun,
Tag,
Trash2,
UserRound
} from "lucide-react";
import {
FormEvent,
useState
} from "react";

import {
LabelGroupSettingsDialog,
LabelSettingsDialog,
WorkflowSettingsDialog,
} from "@/components/task-tracker-catalog-settings";
import { CodexSetupDialog } from "@/components/task-tracker-codex-setup";
import { displayLabel,handleLocalLink } from "@/components/task-tracker-dialog-primitives";

export const settingsNavigation: Array<{
  group: string;
  items: Array<{ section: SettingsSection; label: string; icon: React.ReactNode }>;
}> = [
  { group: "Personal", items: [
    { section: "profile", label: "Profile", icon: <UserRound size={15} /> },
    { section: "appearance", label: "Appearance", icon: <Palette size={15} /> },
  ] },
  { group: "Workspace", items: [
    { section: "workflow-statuses", label: "Workflow statuses", icon: <SlidersHorizontal size={15} /> },
    { section: "labels", label: "Labels", icon: <Tag size={15} /> },
  ] },
  { group: "Integrations", items: [
    { section: "integrations", label: "Codex setup", icon: <CircleHelp size={15} /> },
  ] },
  { group: "Data & backups", items: [
    { section: "project-backup", label: "Project backup", icon: <Database size={15} /> },
    { section: "recently-deleted", label: "Recently deleted", icon: <Trash2 size={15} /> },
  ] },
];

export function SettingsSurface({
  section,
  data,
  theme,
  sidebarCollapsed,
  signOutPath,
  onNavigate,
  onProfile,
  onAppearance,
  onStatuses,
  onLabels,
  onGroups,
  recentlyDeletedEpoch,
  onDeletionWorkspaceChanged,
}: {
  section: string;
  data: AppSnapshot;
  theme: "system" | "light" | "dark";
  sidebarCollapsed: boolean;
  signOutPath: string;
  onNavigate: (section: SettingsSection) => void;
  onProfile: (profile: UserProfile) => void;
  onAppearance: (changes: { theme?: "system" | "light" | "dark"; sidebarPreference?: "expanded" | "collapsed" }) => void;
  onStatuses: (statuses: WorkflowStatusRecord[]) => void;
  onLabels: (labels: LabelRecord[]) => void;
  onGroups?: (groups: LabelGroupRecord[]) => void;
  recentlyDeletedEpoch?: number;
  onDeletionWorkspaceChanged?: () => Promise<unknown> | unknown;
}) {
  const [labelGroupsOpen, setLabelGroupsOpen] = useState(false);
  const active = settingsNavigation.flatMap((group) => group.items)
    .find((item) => item.section === section)?.section ?? "profile";
  const profile = data.userProfile ?? {
    user: {
      ...data.user,
      version: data.user.version ?? 1,
      theme: data.user.theme ?? "system",
      sidebarPreference: data.user.sidebarPreference ?? "expanded",
    },
    identities: [{ provider: "chatgpt" as const, verifiedEmail: data.user.email }],
  };

  return <div className="settings-surface">
    <nav className="settings-navigation" aria-label="Settings sections">
      {settingsNavigation.map((group) => <section key={group.group}>
        <h2>{group.group}</h2>
        {group.items.map((item) => <a
          key={item.section}
          className={active === item.section ? "active" : ""}
          href={`/settings/${item.section}`}
          aria-current={active === item.section ? "page" : undefined}
          onClick={(event) => handleLocalLink(event, () => onNavigate(item.section))}
        >{item.icon}<span>{item.label}</span></a>)}
      </section>)}
    </nav>
    <article className="settings-content">
      {active === "profile" && <SettingsSectionHeader title="Profile" description="Your verified identity and personal date semantics." />}
      {active === "appearance" && <SettingsSectionHeader title="Appearance" description="Choose how Task Manager looks and how its navigation opens." />}
      {active === "workflow-statuses" && <SettingsSectionHeader title="Workflow statuses" description="Manage your account-owned workflow catalog." />}
      {active === "labels" && <SettingsSectionHeader title="Labels" description="Manage labels without losing archived assignments or history." />}
      {active === "integrations" && <SettingsSectionHeader title="Codex setup" description="Connect through the published plugin and OAuth-safe flow." />}
      {active === "project-backup" && <SettingsSectionHeader title="Project backup" description="Export or atomically restore Projects that you currently own." />}
      {active === "recently-deleted" && <SettingsSectionHeader title="Recently deleted" description="Restore deleted records or permanently remove owner-controlled data." />}

      {active === "profile" && <ProfileSettingsPanel key={profile.user.version} profile={profile} signOutPath={signOutPath} onProfile={onProfile} />}
      {active === "appearance" && <AppearanceSettingsPanel theme={theme} sidebarCollapsed={sidebarCollapsed} onChange={onAppearance} />}
      {active === "workflow-statuses" && <WorkflowSettingsDialog embedded initialStatuses={data.statuses.filter((status) => status.ownerUserId === data.user.id)} onClose={() => undefined} onStatuses={onStatuses} />}
      {active === "labels" && <>
        <div className="catalog-toolbar">
          <button className="button ghost compact" type="button" onClick={() => setLabelGroupsOpen(true)}>Manage label groups</button>
        </div>
        <LabelSettingsDialog embedded onClose={() => undefined} onLabels={onLabels} />
        {labelGroupsOpen && <LabelGroupSettingsDialog
          initialGroups={(data.labelGroups ?? []).filter((group) => group.ownerUserId === data.user.id)}
          initialLabels={data.labels.filter((label) => label.ownerUserId === data.user.id)}
          onClose={() => setLabelGroupsOpen(false)}
          onGroups={(groups) => onGroups?.(groups)}
          onLabels={onLabels}
        />}
      </>}
      {active === "integrations" && <CodexSetupDialog embedded onClose={() => undefined} />}
      {active === "project-backup" && <ProjectBackupManager embedded initialSnapshot={data} />}
      {active === "recently-deleted" && <RecentlyDeletedManager invalidationEpoch={recentlyDeletedEpoch} onWorkspaceChanged={onDeletionWorkspaceChanged} />}
    </article>
  </div>;
}
export function SettingsSectionHeader({ title, description }: { title: string; description: string }) {
  return <header className="settings-section-header"><h1>{title}</h1><p>{description}</p></header>;
}

export function ProfileSettingsPanel({
  profile,
  signOutPath,
  onProfile,
}: {
  profile: UserProfile;
  signOutPath: string;
  onProfile: (profile: UserProfile) => void;
}) {
  const [displayName, setDisplayName] = useState(profile.user.displayName);
  const [timezone, setTimezone] = useState(profile.user.timezone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const timezones = supportedTimeZones(profile.user.timezone);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setSaved(false);
    try {
      const response = await fetch("/api/settings/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: profile.user.version, displayName, timezone }),
      });
      const value = await response.json() as UserProfile | { error: string };
      if (!response.ok || "error" in value) {
        if (response.status === 409) {
          const refreshed = await fetch("/api/settings/profile", { cache: "no-store" });
          const latest = await refreshed.json() as UserProfile | { error: string };
          if (refreshed.ok && !("error" in latest)) onProfile(latest);
        }
        throw new Error("error" in value ? value.error : "Profile could not be saved");
      }
      onProfile(value);
      setSaved(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Profile could not be saved");
    } finally {
      setBusy(false);
    }
  }

  return <form className="settings-form" onSubmit={save}>
    <div className="settings-form-row"><span><label htmlFor="settings-display-name">Display name</label><small>Shown on your tasks, comments, and shared resources.</small></span><input id="settings-display-name" required maxLength={120} value={displayName} onChange={(event) => { setDisplayName(event.target.value); setSaved(false); }} /></div>
    <div className="settings-form-row"><span><label htmlFor="settings-verified-email">Verified email</label><small>Managed by the authenticated provider.</small></span><input id="settings-verified-email" readOnly value={profile.user.email} aria-readonly="true" /></div>
    <div className="settings-form-row"><span><label htmlFor="settings-timezone">Timezone</label><small>Used for calendar dates, filters, and displayed timestamps.</small></span><select id="settings-timezone" value={timezone} onChange={(event) => { setTimezone(event.target.value); setSaved(false); }}>{timezones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></div>
    <section className="settings-provider-list" aria-labelledby="linked-provider-heading"><div><h2 id="linked-provider-heading">Linked providers</h2><p>Provider identity is projected by the server and cannot be changed by this form.</p></div>{profile.identities.map((identity) => <div className="settings-provider-row" key={`${identity.provider}:${identity.verifiedEmail}`}><span className="avatar small">{identity.provider === "chatgpt" ? "C" : "G"}</span><span><b>{identity.provider === "chatgpt" ? "ChatGPT" : "Google"}</b><small>{identity.verifiedEmail}</small></span><strong>Verified</strong></div>)}</section>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <div className="settings-form-actions"><span role="status">{saved ? "Saved" : ""}</span><button className="button primary" disabled={busy || !displayName.trim()}>{busy ? "Saving…" : "Save profile"}</button></div>
    <div className="settings-signout"><span><b>Session</b><small>Sign out through the Sites-managed session.</small></span><a className="button secondary" href={signOutPath}><LogOut size={14} />Sign out</a></div>
  </form>;
}

export function AppearanceSettingsPanel({
  theme,
  sidebarCollapsed,
  onChange,
}: {
  theme: "system" | "light" | "dark";
  sidebarCollapsed: boolean;
  onChange: (changes: { theme?: "system" | "light" | "dark"; sidebarPreference?: "expanded" | "collapsed" }) => void;
}) {
  return <div className="settings-form">
    <section className="settings-choice-row"><div className="settings-choice-label"><b>Theme</b><small>Synced to your Task Manager account.</small></div><div role="group" aria-label="Theme preference">{(["system", "light", "dark"] as const).map((value) => <button key={value} type="button" className={theme === value ? "active" : ""} aria-pressed={theme === value} onClick={() => onChange({ theme: value })}>{value === "system" ? <Monitor size={15} /> : value === "light" ? <Sun size={15} /> : <Moon size={15} />}{displayLabel(value)}</button>)}</div></section>
    <section className="settings-choice-row"><div className="settings-choice-label"><b>Sidebar</b><small>Choose the default navigation state for this account.</small></div><div role="group" aria-label="Sidebar preference"><button type="button" className={!sidebarCollapsed ? "active" : ""} aria-pressed={!sidebarCollapsed} onClick={() => onChange({ sidebarPreference: "expanded" })}><PanelLeftOpen size={15} />Expanded</button><button type="button" className={sidebarCollapsed ? "active" : ""} aria-pressed={sidebarCollapsed} onClick={() => onChange({ sidebarPreference: "collapsed" })}><PanelLeftClose size={15} />Collapsed</button></div></section>
  </div>;
}

export function supportedTimeZones(current: string): string[] {
  const values = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] })
    .supportedValuesOf?.("timeZone") ?? [];
  return [...new Set(["UTC", current, ...values])].sort((left, right) => left.localeCompare(right));
}
