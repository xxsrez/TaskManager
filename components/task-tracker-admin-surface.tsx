"use client";

import {
taskPath
} from "@/lib/navigation";
import type {
AdminOverview,
LabelRecord,
ProjectRecord,
TaskRecord,
WorkflowStatusRecord
} from "@/lib/types";
import {
Boxes,
Download,
Inbox,
MessageSquare,
Paperclip,
Search,
Upload,
UsersRound,
X,
Zap
} from "lucide-react";

import {
handleLocalLink,
initials,
zonedDateTime
} from "@/components/task-tracker-dialogs";
import {
LabelChip,
StatusIcon,
TaskHierarchyChip,
type TaskHierarchySummary,
} from "@/components/task-tracker-tasks";


export function AdminSurface({ overview, timeZone, backupBusy, exportActive, onExport, onImport }: {
  overview: AdminOverview;
  timeZone: string;
  backupBusy: boolean;
  exportActive: boolean;
  onExport: () => void;
  onImport: () => void;
}) {
  return (
    <div className="admin-surface">
      <section className="admin-metrics" aria-label="System overview">
        <AdminMetric label="Registered users" value={overview.registeredUserCount} note="All accounts" icon={<UsersRound size={16} />} />
        <AdminMetric label="Active users" value={overview.activeUserCount} note="Last 7 days" icon={<Zap size={16} />} />
        <AdminMetric label="Tasks" value={overview.taskCount} note={`${overview.projectCount} projects`} icon={<Inbox size={16} />} />
        <AdminMetric label="Saved views" value={overview.viewCount} note={`${overview.releaseCount} releases`} icon={<Boxes size={16} />} />
        <AdminMetric label="Attachment objects" value={overview.attachmentObjectCount} note={`${formatAttachmentBytes(overview.attachmentObjectBytes)} · ${overview.orphanAttachmentObjectCount === null ? "orphan scan bounded" : `${overview.orphanAttachmentObjectCount} orphan`} · ${overview.stagingAttachmentObjectCount} staged · ${overview.pendingAttachmentCount} pending · ${overview.failedAttachmentCount} failed`} icon={<Paperclip size={16} />} />
      </section>
      <section className="admin-panel admin-backup-panel" aria-labelledby="admin-backup-heading">
        <header>
          <div>
            <h2 id="admin-backup-heading">Резервное копирование и восстановление</h2>
            <p>Полная резервная копия содержит данные всех пользователей, идентификаторы и права доступа. Храните файл <code>.tmbak</code> как секрет; восстановление полностью заменяет текущее состояние.</p>
          </div>
          <span className="status-badge admin-badge">Только администратор</span>
        </header>
        <div className="admin-backup-actions">
          <article>
            <span className="admin-backup-icon"><Download size={17} /></span>
            <div>
              <h3>Экспорт</h3>
              <p>Создать переносимый снимок D1 и R2 в возобновляемом формате <code>.tmbak</code>.</p>
            </div>
            <button className="button ghost" type="button" disabled={backupBusy && !exportActive} onClick={onExport}><Download size={14} />{exportActive ? "Открыть экспорт" : "Экспорт"}</button>
          </article>
          <article className="destructive">
            <span className="admin-backup-icon"><Upload size={17} /></span>
            <div>
              <h3>Полное восстановление</h3>
              <p>Проверить резервную копию и заменить все данные после отдельного подтверждения.</p>
            </div>
            <button className="button danger" type="button" disabled={backupBusy} onClick={onImport}><Upload size={14} />Импорт</button>
          </article>
        </div>
      </section>
      <section className="admin-panel">
        <header>
          <div>
            <h2>Users</h2>
            <p>Last active reflects the latest authenticated request. Content activity is the latest owned record change. Times are shown in {timeZone}.</p>
          </div>
          <span className="status-badge">Live totals</span>
        </header>
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Registered</th>
                <th>Last active</th>
                <th>Content activity</th>
                <th>Tasks</th>
                <th>Projects</th>
                <th>Releases</th>
                <th>Views</th>
              </tr>
            </thead>
            <tbody>
              {overview.users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <span className="admin-user">
                      <span className="avatar">{initials(user.displayName)}</span>
                      <span><b>{user.displayName}</b><small>{user.email}</small></span>
                      {user.isAdmin && <span className="status-badge admin-badge">Admin</span>}
                    </span>
                  </td>
                  <td><time dateTime={user.registeredAt}>{zonedDateTime(user.registeredAt, timeZone)}</time></td>
                  <td><time dateTime={user.lastSeenAt}>{zonedDateTime(user.lastSeenAt, timeZone)}</time></td>
                  <td>{user.lastContentActivityAt ? <time dateTime={user.lastContentActivityAt}>{zonedDateTime(user.lastContentActivityAt, timeZone)}</time> : <span className="muted-value">—</span>}</td>
                  <td><span className="admin-task-count"><b>{user.taskCount}</b><small>{user.recentTaskCount} changed in 7d</small></span></td>
                  <td>{user.projectCount}</td>
                  <td>{user.releaseCount}</td>
                  <td>{user.viewCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
export function AdminMetric({ label, value, note, icon }: { label: string; value: number; note: string; icon: React.ReactNode }) { return <article className="admin-metric"><span className="admin-metric-icon">{icon}</span><div><span>{label}</span><b>{value}</b><small>{note}</small></div></article>; }
export function formatAttachmentBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`; if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`; return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`; }
export function TaskSearchNotice({ status }: { status: "loading" | "error" }) { return <div className="empty-state" role="status"><Search size={22} /><h2>{status === "loading" ? "Searching tasks…" : "Search unavailable"}</h2><p>{status === "loading" ? "Looking across every task you can access." : "The search request failed. Change the query or try again."}</p></div>; }
export function TaskQueryPagination({ busy, onMore }: { busy: boolean; onMore: () => void }) { return <div className="task-query-pagination" role="status"><span>More matching tasks are available.</span><button className="button ghost" type="button" disabled={busy} onClick={onMore}>{busy ? "Loading…" : "Load more"}</button></div>; }
export function CatalogPagination({ busy, onMore }: { busy: boolean; onMore: () => void }) { return <div className="task-query-pagination" role="status"><span>More records are available.</span><button className="button ghost" type="button" disabled={busy} onClick={onMore}>{busy ? "Loading…" : "Load more"}</button></div>; }
export function Peek({ task, status, project, labels, hierarchy, onClose, onOpen }: { task: TaskRecord; status?: WorkflowStatusRecord; project?: ProjectRecord; labels: LabelRecord[]; hierarchy: TaskHierarchySummary; onClose: () => void; onOpen: () => void }) { return <div className="peek" role="dialog" aria-label={`Preview ${task.identifier}`}><header><span>{task.identifier}</span><div><a href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, onOpen)}>Open</a><button onClick={onClose}><X size={13} /></button></div></header><h2>{task.title}</h2><p>{task.description === null ? "Loading preview…" : task.description || "No description"}</p>{labels.length > 0 && <div className="card-labels">{labels.map((label) => <LabelChip key={label.id} label={label} />)}</div>}{(hierarchy.parent || hierarchy.subtaskCount > 0) && <div className="peek-hierarchy"><TaskHierarchyChip hierarchy={hierarchy} /></div>}<footer>{status && <span><StatusIcon status={status} />{status.name}</span>}{project && <span><span className="project-dot" style={{ background: project.color }} />{project.name}</span>}<span><MessageSquare size={12} />{task.commentCount}</span></footer></div>; }
