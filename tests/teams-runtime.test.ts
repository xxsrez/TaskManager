import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from "../lib/domain";
import {
  createProject,
  createSavedView,
  createTask,
  getOrCreateUser,
  getSnapshot,
  grantAccess,
  searchWorkspace,
  updateTask,
} from "../lib/repository";
import {
  addTeamMember,
  createTeam,
  deleteTeamMember,
  getTeamGrantContext,
  getTeamsCatalog,
  grantTeamAccess,
  revokeTeamAccess,
  updateTeamMember,
} from "../lib/teams";
import { createD1TestHarness } from "./helpers/d1";
import { parseAgentTaskListQuery } from "../lib/agent-api-contract";
import {
  getAgentTaskDetail,
  getAgentWorkspace,
  listAgentTasks,
} from "../lib/agent-api-repository";
import { createTaskRelation } from "../lib/task-relations";

let dispose: (() => Promise<void>) | undefined;
let database: D1Database;

before(async () => {
  const harness = await createD1TestHarness();
  database = harness.database;
  dispose = harness.dispose;
});

after(async () => {
  await dispose?.();
});

const actor = (key: string, name: string) => ({
  provider: "chatgpt" as const,
  providerAccountKey: `teams-${key}`,
  displayName: name,
  email: `teams-${key}@example.test`,
});

test("Team membership lifecycle is owner-scoped, versioned, and non-duplicating", async () => {
  const owner = await getOrCreateUser(actor("owner", "Team Owner"));
  const member = await getOrCreateUser(actor("member", "Team Member"));
  const second = await getOrCreateUser(actor("second", "Second Member"));
  const removable = await getOrCreateUser(actor("removable", "Removable Member"));
  const outsider = await getOrCreateUser(actor("outsider", "Outsider"));

  await createTeam(owner, { name: "Runtime Team" });
  let ownerCatalog = await getTeamsCatalog(owner);
  let team = ownerCatalog.teams[0]!;
  assert.equal(team.version, 1);
  assert.equal(team.activeMemberCount, 1);
  assert.equal(ownerCatalog.memberships[0]?.role, "owner");

  await addTeamMember(owner, team.id, {
    teamVersion: team.version,
    email: member.email,
  });
  ownerCatalog = await getTeamsCatalog(owner);
  team = ownerCatalog.teams[0]!;
  assert.equal(team.version, 2);
  assert.equal(team.activeMemberCount, 2);

  await assert.rejects(
    addTeamMember(owner, team.id, {
      teamVersion: 1,
      email: second.email,
    }),
    ConflictError,
  );
  await addTeamMember(owner, team.id, {
    teamVersion: team.version,
    email: second.email,
  });
  ownerCatalog = await getTeamsCatalog(owner);
  team = ownerCatalog.teams[0]!;
  assert.equal(ownerCatalog.memberships.filter((row) => row.userId === second.id).length, 1);

  let secondMembership = ownerCatalog.memberships.find((row) => row.userId === second.id)!;
  await updateTeamMember(owner, team.id, secondMembership.id, {
    teamVersion: team.version,
    membershipVersion: secondMembership.version,
    status: "inactive",
  });
  assert.equal((await getTeamsCatalog(second)).teams.length, 0);
  ownerCatalog = await getTeamsCatalog(owner);
  team = ownerCatalog.teams[0]!;
  secondMembership = ownerCatalog.memberships.find((row) => row.userId === second.id)!;
  assert.equal(secondMembership.status, "inactive");
  assert.ok(secondMembership.deactivatedAt);

  await updateTeamMember(owner, team.id, secondMembership.id, {
    teamVersion: team.version,
    membershipVersion: secondMembership.version,
    status: "active",
  });
  assert.equal((await getTeamsCatalog(second)).teams[0]?.id, team.id);
  ownerCatalog = await getTeamsCatalog(owner);
  team = ownerCatalog.teams[0]!;

  await addTeamMember(owner, team.id, {
    teamVersion: team.version,
    email: removable.email,
  });
  ownerCatalog = await getTeamsCatalog(owner);
  team = ownerCatalog.teams[0]!;
  const removableMembership = ownerCatalog.memberships.find(
    (row) => row.userId === removable.id,
  )!;
  await deleteTeamMember(owner, team.id, removableMembership.id, {
    teamVersion: team.version,
    membershipVersion: removableMembership.version,
  });
  ownerCatalog = await getTeamsCatalog(owner);
  team = ownerCatalog.teams[0]!;
  assert.equal(ownerCatalog.memberships.some((row) => row.userId === removable.id), false);

  const ownerMembership = ownerCatalog.memberships.find((row) => row.role === "owner")!;
  await assert.rejects(
    deleteTeamMember(owner, team.id, ownerMembership.id, {
      teamVersion: team.version,
      membershipVersion: ownerMembership.version,
    }),
    ValidationError,
  );
  await assert.rejects(
    addTeamMember(outsider, team.id, {
      teamVersion: team.version,
      email: removable.email,
    }),
    NotFoundError,
  );
});

test("Team grants use the strongest active route without changing direct grants", async () => {
  const owner = await getOrCreateUser(actor("acl-owner", "ACL Owner"));
  const directMember = await getOrCreateUser(actor("acl-direct", "Direct Member"));
  const taskMember = await getOrCreateUser(actor("acl-task", "Task Member"));
  const outsider = await getOrCreateUser(actor("acl-outsider", "ACL Outsider"));

  await createTeam(owner, { name: "ACL Team" });
  let catalog = await getTeamsCatalog(owner);
  let team = catalog.teams[0]!;
  await addTeamMember(owner, team.id, {
    teamVersion: team.version,
    email: directMember.email,
  });
  catalog = await getTeamsCatalog(owner);
  team = catalog.teams[0]!;
  await addTeamMember(owner, team.id, {
    teamVersion: team.version,
    email: taskMember.email,
  });
  catalog = await getTeamsCatalog(owner);
  team = catalog.teams[0]!;

  await createProject(owner, { name: "Team ACL Project", taskCode: "TACL" });
  const project = (await getSnapshot(owner)).projects.find(
    (row) => row.name === "Team ACL Project",
  )!;
  const targetIdentity = await createTask(owner, {
    title: "Team target",
    projectId: project.id,
  });
  const siblingIdentity = await createTask(owner, {
    title: "Private sibling",
    projectId: project.id,
  });
  const directGrantCount = async () => Number((await database.prepare(
    "SELECT COUNT(*) AS count FROM access_grants",
  ).first<{ count: number }>())?.count ?? 0);
  const directBefore = await directGrantCount();

  await grantTeamAccess(owner, {
    teamId: team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
  });
  assert.equal(await directGrantCount(), directBefore);
  let memberSnapshot = await getSnapshot(directMember);
  assert.equal(memberSnapshot.projects.find((row) => row.id === project.id)?.accessRole, "viewer");
  assert.equal(
    memberSnapshot.tasks.find((row) => row.id === targetIdentity.id)?.accessRole,
    "viewer",
  );
  assert.ok(memberSnapshot.statuses.some(
    (row) => row.id === memberSnapshot.tasks.find((task) => task.id === targetIdentity.id)?.statusId,
  ));
  const viewerTask = memberSnapshot.tasks.find((row) => row.id === targetIdentity.id)!;
  await assert.rejects(
    updateTask(directMember, viewerTask.id, {
      version: viewerTask.version,
      title: "Viewer cannot edit",
    }),
    PermissionError,
  );

  await createTeam(owner, { name: "Second ACL Team" });
  let secondCatalog = await getTeamsCatalog(owner);
  let secondTeam = secondCatalog.teams.find((row) => row.name === "Second ACL Team")!;
  await addTeamMember(owner, secondTeam.id, {
    teamVersion: secondTeam.version,
    email: directMember.email,
  });
  secondCatalog = await getTeamsCatalog(owner);
  secondTeam = secondCatalog.teams.find((row) => row.id === secondTeam.id)!;
  await grantTeamAccess(owner, {
    teamId: secondTeam.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "editor",
  });
  assert.equal(await directGrantCount(), directBefore);
  memberSnapshot = await getSnapshot(directMember);
  assert.equal(memberSnapshot.projects.find((row) => row.id === project.id)?.accessRole, "editor");
  const teamCreatedTask = await createTask(directMember, {
    title: "Created through Team Project Editor",
    projectId: project.id,
  });
  await createTaskRelation(directMember, targetIdentity.id, {
    targetTaskId: teamCreatedTask.id,
    type: "related",
    direction: "outgoing",
    idempotencyKey: "teams-runtime-project-editor-relation",
  });
  const multiTeamContext = await getTeamGrantContext(owner, {
    resourceType: "project",
    resourceId: project.id,
  });
  const secondTeamGrant = multiTeamContext.grants.find((row) => row.teamId === secondTeam.id)!;
  await revokeTeamAccess(owner, {
    teamId: secondTeam.id,
    resourceType: "project",
    resourceId: project.id,
    version: secondTeamGrant.version,
  });
  memberSnapshot = await getSnapshot(directMember);
  assert.equal(memberSnapshot.projects.find((row) => row.id === project.id)?.accessRole, "viewer");

  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: directMember.email,
    permission: "editor",
  });
  assert.equal(await directGrantCount(), directBefore + 1);
  memberSnapshot = await getSnapshot(directMember);
  assert.equal(memberSnapshot.projects.find((row) => row.id === project.id)?.accessRole, "editor");

  let context = await getTeamGrantContext(owner, {
    resourceType: "project",
    resourceId: project.id,
  });
  const projectTeamGrant = context.grants[0]!;
  await revokeTeamAccess(owner, {
    teamId: team.id,
    resourceType: "project",
    resourceId: project.id,
    version: projectTeamGrant.version,
  });
  assert.equal(await directGrantCount(), directBefore + 1);
  memberSnapshot = await getSnapshot(directMember);
  assert.equal(memberSnapshot.projects.find((row) => row.id === project.id)?.accessRole, "editor");

  await grantTeamAccess(owner, {
    teamId: team.id,
    resourceType: "task",
    resourceId: targetIdentity.id,
    permission: "editor",
  });
  let taskSnapshot = await getSnapshot(taskMember);
  const teamTask = taskSnapshot.tasks.find((row) => row.id === targetIdentity.id)!;
  assert.equal(teamTask.accessRole, "editor");
  assert.equal(taskSnapshot.projects.some((row) => row.id === project.id), false);
  assert.equal(taskSnapshot.tasks.some((row) => row.id === siblingIdentity.id), false);
  assert.equal(taskSnapshot.tasks.some((row) => row.id === teamCreatedTask.id), false);
  const searchResult = await searchWorkspace(taskMember, {
    query: "Team target",
    limit: 10,
  });
  assert.equal(searchResult.groups.tasks.some((row) => row.id === targetIdentity.id), true);
  assert.equal(searchResult.groups.projects.some((row) => row.id === project.id), false);
  const agentTasks = await listAgentTasks(
    taskMember,
    await parseAgentTaskListQuery(new URLSearchParams("order=title")),
  );
  assert.equal(agentTasks.data.some((row) => row.ref === targetIdentity.publicId), true);
  assert.equal(agentTasks.data.some((row) => row.ref === siblingIdentity.publicId), false);
  assert.equal((await getAgentTaskDetail(taskMember, targetIdentity.publicId)).access.role, "editor");
  const agentWorkspace = await getAgentWorkspace({
    authorizationId: "teams-runtime",
    authorizationType: "personal_token",
    clientId: "teams-runtime",
    scopes: ["api:read", "api:write"],
    user: taskMember,
    expiresAt: null,
    resource: null,
  });
  assert.equal(agentWorkspace.counts.tasks.total, 1);
  assert.equal(agentWorkspace.counts.projects, 0);
  assert.ok(agentWorkspace.statuses.some(
    (row) => row.name === taskSnapshot.statuses.find((status) => status.id === teamTask.statusId)?.name,
  ));
  await updateTask(taskMember, teamTask.id, {
    version: teamTask.version,
    title: "Edited through direct Team task route",
  });
  assert.equal((await getSnapshot(owner)).tasks.find(
    (row) => row.id === targetIdentity.id,
  )?.title, "Edited through direct Team task route");
  const ownerTarget = (await getSnapshot(owner)).tasks.find(
    (row) => row.id === targetIdentity.id,
  )!;
  await updateTask(owner, ownerTarget.id, {
    version: ownerTarget.version,
    assigneeUserId: taskMember.id,
  });
  assert.equal((await getSnapshot(owner)).tasks.find(
    (row) => row.id === targetIdentity.id,
  )?.assigneeUserId, taskMember.id);

  await grantTeamAccess(owner, {
    teamId: team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
  });
  taskSnapshot = await getSnapshot(taskMember);
  assert.equal(taskSnapshot.projects.find((row) => row.id === project.id)?.accessRole, "viewer");
  assert.equal(taskSnapshot.tasks.find((row) => row.id === siblingIdentity.id)?.accessRole, "viewer");
  assert.equal(taskSnapshot.tasks.find((row) => row.id === targetIdentity.id)?.accessRole, "editor");
  let taskGrantContext = await getTeamGrantContext(owner, {
    resourceType: "task",
    resourceId: targetIdentity.id,
  });
  await revokeTeamAccess(owner, {
    teamId: team.id,
    resourceType: "task",
    resourceId: targetIdentity.id,
    version: taskGrantContext.grants[0]!.version,
  });
  assert.equal(
    (await getSnapshot(taskMember)).tasks.find((row) => row.id === targetIdentity.id)?.accessRole,
    "viewer",
  );
  await grantTeamAccess(owner, {
    teamId: team.id,
    resourceType: "task",
    resourceId: targetIdentity.id,
    permission: "editor",
  });
  taskGrantContext = await getTeamGrantContext(owner, {
    resourceType: "task",
    resourceId: targetIdentity.id,
  });
  assert.equal(taskGrantContext.grants[0]?.permission, "editor");

  catalog = await getTeamsCatalog(owner);
  team = catalog.teams.find((row) => row.id === team.id)!;
  let taskMembership = catalog.memberships.find((row) => row.userId === taskMember.id)!;
  await updateTeamMember(owner, team.id, taskMembership.id, {
    teamVersion: team.version,
    membershipVersion: taskMembership.version,
    status: "inactive",
  });
  taskSnapshot = await getSnapshot(taskMember);
  assert.equal(taskSnapshot.tasks.some((row) => row.id === targetIdentity.id), false);
  catalog = await getTeamsCatalog(owner);
  team = catalog.teams.find((row) => row.id === team.id)!;
  taskMembership = catalog.memberships.find((row) => row.userId === taskMember.id)!;
  await updateTeamMember(owner, team.id, taskMembership.id, {
    teamVersion: team.version,
    membershipVersion: taskMembership.version,
    status: "active",
  });

  const globalView = await createSavedView(owner, {
    name: "Team global view",
    query: {},
    display: {
      layout: "list",
      groupBy: "status",
      orderBy: "manual",
      direction: "asc",
      showEmptyGroups: false,
      visibleFields: ["priority"],
    },
  });
  await grantTeamAccess(owner, {
    teamId: team.id,
    resourceType: "saved_view",
    resourceId: globalView.id,
    permission: "viewer",
  });
  assert.equal(
    (await getSnapshot(taskMember)).views.find((row) => row.id === globalView.id)?.accessRole,
    "viewer",
  );
  const scopedView = await createSavedView(owner, {
    name: "Team scoped view",
    scopeProjectId: project.id,
    query: { projectId: project.id },
    display: {
      layout: "list",
      groupBy: "status",
      orderBy: "manual",
      direction: "asc",
      showEmptyGroups: false,
      visibleFields: ["project"],
    },
  });
  await assert.rejects(
    grantTeamAccess(owner, {
      teamId: team.id,
      resourceType: "saved_view",
      resourceId: scopedView.id,
      permission: "viewer",
    }),
    ValidationError,
  );
  await assert.rejects(
    getTeamGrantContext(outsider, {
      resourceType: "project",
      resourceId: project.id,
    }),
    NotFoundError,
  );
  context = await getTeamGrantContext(owner, {
    resourceType: "task",
    resourceId: targetIdentity.id,
  });
  assert.equal(context.grants[0]?.teamId, team.id);
  assert.equal(await directGrantCount(), directBefore + 1);
});

test("Teams persist dedicated state only in the three baseline tables", async () => {
  const owner = await getOrCreateUser(actor("persistence-owner", "Persistence Owner"));
  const member = await getOrCreateUser(actor("persistence-member", "Persistence Member"));
  await createProject(owner, { name: "Persistence Project", taskCode: "PERS" });
  const project = (await getSnapshot(owner)).projects.find(
    (row) => row.name === "Persistence Project",
  )!;
  const task = await createTask(owner, {
    title: "Persistence Task",
    projectId: project.id,
  });
  const view = await createSavedView(owner, {
    name: "Persistence global view",
    query: {},
    display: {
      layout: "list",
      groupBy: "status",
      orderBy: "manual",
      direction: "asc",
      showEmptyGroups: false,
      visibleFields: ["priority"],
    },
  });

  const tableCounts = async () => {
    const tables = await database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    const entries = await Promise.all(tables.results
      .filter(({ name }) => !name.toLowerCase().startsWith("_cf_"))
      .map(async ({ name }) => {
      assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
      const row = await database.prepare(`SELECT COUNT(*) AS count FROM "${name}"`)
        .first<{ count: number }>();
      return [name, Number(row?.count ?? 0)] as const;
      }));
    return new Map(entries);
  };
  const before = await tableCounts();

  await createTeam(owner, { name: "Persistence Team" });
  let catalog = await getTeamsCatalog(owner);
  let team = catalog.teams.find((row) => row.name === "Persistence Team")!;
  await addTeamMember(owner, team.id, {
    teamVersion: team.version,
    email: member.email,
  });
  catalog = await getTeamsCatalog(owner);
  team = catalog.teams.find((row) => row.id === team.id)!;
  await grantTeamAccess(owner, {
    teamId: team.id,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
  });
  await grantTeamAccess(owner, {
    teamId: team.id,
    resourceType: "task",
    resourceId: task.id,
    permission: "editor",
  });
  await grantTeamAccess(owner, {
    teamId: team.id,
    resourceType: "saved_view",
    resourceId: view.id,
    permission: "viewer",
  });

  const after = await tableCounts();
  assert.equal(after.get("teams"), (before.get("teams") ?? 0) + 1);
  assert.equal(after.get("team_memberships"), (before.get("team_memberships") ?? 0) + 2);
  assert.equal(after.get("team_grants"), (before.get("team_grants") ?? 0) + 3);
  for (const [name, count] of before) {
    if (["teams", "team_memberships", "team_grants"].includes(name)) continue;
    assert.equal(after.get(name), count, `${name} changed during Team-only commands`);
  }
  assert.deepEqual(
    (await database.prepare(
      `SELECT resource_type, resource_id, permission, revoked_at
       FROM team_grants WHERE team_id = ? ORDER BY resource_type`,
    ).bind(team.id).all()).results,
    [
      { resource_type: "project", resource_id: project.id, permission: "viewer", revoked_at: null },
      { resource_type: "saved_view", resource_id: view.id, permission: "viewer", revoked_at: null },
      { resource_type: "task", resource_id: task.id, permission: "editor", revoked_at: null },
    ],
  );
});
