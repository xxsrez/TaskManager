"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { Plus, RotateCw, ShieldCheck, UserRound, UsersRound } from "lucide-react";
import type { TeamDetailRecord, TeamRecord } from "@/lib/types";

type TeamsResponse = { teams: TeamRecord[] };
type TeamResponse = { team: TeamDetailRecord };

export function TeamsSurface({
  teamRef,
  onOpen,
}: {
  teamRef: string | null;
  onOpen: (publicId: string) => void;
}) {
  const [teams, setTeams] = useState<TeamRecord[]>([]);
  const [team, setTeam] = useState<TeamDetailRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(teamRef
        ? `/api/teams/${encodeURIComponent(teamRef)}`
        : "/api/teams", { cache: "no-store" });
      const payload = await readPayload(response);
      if (teamRef) setTeam((payload as TeamResponse).team);
      else setTeams((payload as TeamsResponse).teams);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoading(false);
    }
  }, [teamRef]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError("");
    try {
      const payload = await mutateTeam("/api/teams", "POST", {
        name: String(values.get("name") ?? ""),
      });
      form.reset();
      onOpen(payload.team.publicId);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!team) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    await changeTeam(
      `/api/teams/${encodeURIComponent(team.publicId)}/members`,
      "POST",
      { email: String(values.get("email") ?? "") },
    );
    form.reset();
  }

  async function changeMembership(
    membershipId: string,
    version: number,
    status: "active" | "inactive",
  ) {
    if (!team) return;
    await changeTeam(
      `/api/teams/${encodeURIComponent(team.publicId)}/members/${encodeURIComponent(membershipId)}`,
      "PATCH",
      { version, status },
    );
  }

  async function removeMembership(membershipId: string, version: number) {
    if (!team) return;
    await changeTeam(
      `/api/teams/${encodeURIComponent(team.publicId)}/members/${encodeURIComponent(membershipId)}`,
      "DELETE",
      { version },
    );
  }

  async function changeTeam(url: string, method: "POST" | "PATCH" | "DELETE", body: object) {
    setBusy(true);
    setError("");
    try {
      const payload = await mutateTeam(url, method, body);
      setTeam(payload.team);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="team-surface-state"><RotateCw className="spin" size={18} />Loading Teams…</div>;

  if (teamRef) {
    if (!team) return <div className="team-surface-state error">{error || "Team not found"}</div>;
    return <section className="teams-surface team-detail-surface">
      <header className="entity-catalog-header">
        <div><span className="eyebrow">Team</span><h2>{team.name}</h2><p>Only active members receive access through this Team.</p></div>
        <span className="team-member-count"><UsersRound size={15} />{team.activeMemberCount} active</span>
      </header>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {team.canManageMembers && <form className="team-member-form" onSubmit={addMember}>
        <label><span>Add registered person</span><input name="email" type="email" required placeholder="name@example.com" autoComplete="off" /></label>
        <button className="button primary" disabled={busy}><Plus size={14} />Add member</button>
      </form>}
      <div className="team-member-list" role="list">
        {team.members.map((membership) => <article className={`team-member-row ${membership.status}`} key={membership.id} role="listitem">
          <span className="avatar"><UserRound size={15} /></span>
          <span className="team-member-identity"><b>{membership.displayName}</b><small>{membership.email}</small></span>
          <span className="team-membership-role">{membership.role === "owner" ? <><ShieldCheck size={13} />Owner</> : "Member"}</span>
          <span className={`team-membership-status ${membership.status}`}>{membership.status}</span>
          {team.canManageMembers && membership.role !== "owner" && <div className="team-member-actions">
            <button className="button ghost compact" type="button" disabled={busy} onClick={() => void changeMembership(membership.id, membership.version, membership.status === "active" ? "inactive" : "active")}>{membership.status === "active" ? "Deactivate" : "Reactivate"}</button>
            <button className="button ghost compact danger" type="button" disabled={busy} onClick={() => void removeMembership(membership.id, membership.version)}>Remove</button>
          </div>}
        </article>)}
      </div>
    </section>;
  }

  return <section className="teams-surface">
    <header className="entity-catalog-header">
      <div><span className="eyebrow">Access catalog</span><h2>Teams</h2><p>Reusable groups for Project, Task, and global SavedView access.</p></div>
    </header>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <form className="team-create-form" onSubmit={create}>
      <label><span>New Team</span><input name="name" required maxLength={100} placeholder="Design systems" /></label>
      <button className="button primary" disabled={busy}><Plus size={14} />Create Team</button>
    </form>
    <div className="entity-grid team-grid">
      {teams.map((item) => <a className="entity-card" href={`/teams/${encodeURIComponent(item.publicId)}`} key={item.id} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpen(item.publicId); }}>
        <div className="entity-icon"><UsersRound size={18} /></div>
        <div className="entity-card-copy"><div><h2>{item.name}</h2><span className="status-badge">{item.currentMembership.role}</span></div><p>{item.canManageMembers ? "You manage this Team" : "Active membership"}</p><div className="progress-meta"><span>{item.activeMemberCount} active members</span><span>Open Team</span></div></div>
      </a>)}
      {teams.length === 0 && <div className="empty-state"><UsersRound size={24} /><h2>No Teams yet</h2><p>Create a Team to share one resource with a maintained group.</p></div>}
    </div>
  </section>;
}

async function mutateTeam(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body: object,
): Promise<TeamResponse> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readPayload(response) as Promise<TeamResponse>;
}

async function readPayload(response: Response): Promise<unknown> {
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : "Team request failed";
    throw new Error(message);
  }
  return payload;
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Team request failed";
}
