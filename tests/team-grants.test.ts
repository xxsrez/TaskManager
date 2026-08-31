import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { configureActorResolverForTests } from "../lib/auth";
import {
  getAgentTaskDetail,
  getAgentWorkspace,
  listAgentLabels,
} from "../lib/agent-api-repository";
import {
  createLabel,
  createProject,
  createRelease,
  createSavedView,
  createTask,
  getSnapshot,
  getTask,
  loadAccessibleProject,
  loadAccessibleRelease,
  loadAccessibleTask,
  loadAccessibleView,
  queryTaskSummaries,
  searchWorkspace,
  updateTask,
} from "../lib/repository";
import {
  addTeamMember,
  createTeam,
  updateTeamMembership,
} from "../lib/teams";
import { createWorkflowStatus } from "../lib/workflow-statuses";
import { getOrCreateUser } from "../lib/repository";
import { grantAccess } from "../lib/repository";
import {
  DELETE as revokeTeamGrant,
  PATCH as patchTeamGrant,
} from "../app/api/team-grants/[id]/route";
import {
  GET as listTeamGrants,
  POST as createTeamGrant,
} from "../app/api/team-grants/route";
import { createD1TestHarness } from "./helpers/d1";

const resourceOwnerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "team-grants-resource-owner",
  displayName: "Team Grant Resource Owner",
  email: "team-grants-resource-owner@example.test",
};
const teamOwnerOneActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "team-grants-team-owner-one",
  displayName: "Team Grant Team Owner One",
  email: "team-grants-team-owner-one@example.test",
};
const teamOwnerTwoActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "team-grants-team-owner-two",
  displayName: "Team Grant Team Owner Two",
  email: "team-grants-team-owner-two@example.test",
};
const grantActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "team-grants-grant-actor",
  displayName: "Team Grant Actor",
  email: "team-grants-grant-actor@example.test",
};
const recipientActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "team-grants-recipient",
  displayName: "Team Grant Recipient",
  email: "team-grants-recipient@example.test",
};
const outsiderActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "team-grants-outsider",
  displayName: "Team Grant Outsider",
  email: "team-grants-outsider@example.test",
};

let database: D1Database;
let dispose: (() => Promise<void>) | undefined;

before(async () => {
  const harness = await createD1TestHarness();
  database = harness.database;
  dispose = harness.dispose;
});

after(async () => {
  configureActorResolverForTests(null);
  await dispose?.();
});

test("Team grants use effective ACL roles, exact targets, lifecycle CAS, and no leaks", async () => {
  const resourceOwner = await getOrCreateUser(resourceOwnerActor);
  const teamOwnerOne = await getOrCreateUser(teamOwnerOneActor);
  const teamOwnerTwo = await getOrCreateUser(teamOwnerTwoActor);
  const actor = await getOrCreateUser(grantActor);
  const recipient = await getOrCreateUser(recipientActor);
  await getOrCreateUser(outsiderActor);

  await createProject(resourceOwner, {
    name: "Team grant project",
    taskCode: "TGR",
  });
  const projectRow = await database
    .prepare("SELECT id FROM projects WHERE owner_user_id = ? AND task_code = ?")
    .bind(resourceOwner.id, "TGR")
    .first<{ id: string }>();
  assert.ok(projectRow);
  const project = await loadAccessibleProject(resourceOwner.id, projectRow.id);
  const firstTask = await createTask(resourceOwner, {
    title: "Team grant exact task",
    projectId: project.id,
  });
  const siblingTask = await createTask(resourceOwner, {
    title: "Team grant sibling task",
    projectId: project.id,
  });
  const release = await createRelease(resourceOwner, {
    name: "Team grant release",
    projectId: project.id,
  });
  const globalView = await createSavedView(resourceOwner, {
    name: "Team grant global view",
    query: {},
    display: { layout: "list" },
  });
  const projectView = await createSavedView(resourceOwner, {
    name: "Team grant project view",
    scopeProjectId: project.id,
    query: {},
    display: { layout: "list" },
  });
  await createWorkflowStatus(resourceOwner, {
    name: "Team grant project status",
    category: "started",
    color: "#aa55cc",
  });
  const projectLabelCatalog = await createLabel(resourceOwner, {
    name: "Team grant project label",
    color: "#55aacc",
  });
  assert.ok(projectLabelCatalog.some((label) => label.name === "Team grant project label"));
  await grantAccess(resourceOwner, {
    resourceType: "project",
    resourceId: project.id,
    email: actor.email,
    permission: "manager",
  });

  const teamOne = await createTeam(teamOwnerOne, { name: "Team Grant One" });
  const teamTwo = await createTeam(teamOwnerTwo, { name: "Team Grant Two" });
  const actorMembershipOne = await addTeamMember(teamOwnerOne, teamOne.team.publicId, {
    email: actor.email,
  });
  const recipientMembershipOne = await addTeamMember(teamOwnerOne, teamOne.team.publicId, {
    email: recipient.email,
  });
  const actorMembershipTwo = await addTeamMember(teamOwnerTwo, teamTwo.team.publicId, {
    email: actor.email,
  });
  const recipientMembershipTwo = await addTeamMember(teamOwnerTwo, teamTwo.team.publicId, {
    email: recipient.email,
  });
  const resourceOwnerMembershipOne = await addTeamMember(teamOwnerOne, teamOne.team.publicId, {
    email: resourceOwner.email,
  });
  assert.equal(actorMembershipOne.membership.role, "member");
  assert.equal(actorMembershipTwo.membership.role, "member");

  const directGrantCount = Number(
    (await database.prepare("SELECT COUNT(*) AS count FROM access_grants").first<{ count: number }>())?.count ?? 0,
  );
  configureActorResolverForTests(async () => grantActor);

  const exactTaskGrantResponse = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamOne.team.publicId,
    resourceType: "task",
    resourceId: firstTask.id,
    permission: "editor",
  }));
  assert.equal(exactTaskGrantResponse.status, 200);
  const exactTaskGrant = await json<{ grant: TeamGrant }>(exactTaskGrantResponse);
  assert.equal(exactTaskGrant.grant.permission, "editor");
  assert.equal(exactTaskGrant.grant.version, 1);

  configureActorResolverForTests(async () => resourceOwnerActor);
  const globalViewGrantResponse = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamOne.team.publicId,
    resourceType: "saved_view",
    resourceId: globalView.id,
    permission: "viewer",
  }));
  assert.equal(globalViewGrantResponse.status, 200);
  const globalViewGrant = await json<{ grant: TeamGrant }>(globalViewGrantResponse);
  configureActorResolverForTests(async () => grantActor);

  const invalidTaskManager = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamOne.team.publicId,
    resourceType: "task",
    resourceId: siblingTask.id,
    permission: "manager",
  }));
  assert.equal(invalidTaskManager.status, 400);
  const managerCannotGrantProjectManager = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamOne.team.publicId,
    resourceType: "project",
    resourceId: project.id,
    permission: "manager",
  }));
  assert.equal(managerCannotGrantProjectManager.status, 403);
  const invalidScopedView = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamOne.team.publicId,
    resourceType: "saved_view",
    resourceId: projectView.id,
    permission: "viewer",
  }));
  assert.equal(invalidScopedView.status, 400);
  const invalidViewManager = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamOne.team.publicId,
    resourceType: "saved_view",
    resourceId: globalView.id,
    permission: "manager",
  }));
  assert.equal(invalidViewManager.status, 400);
  const missingTarget = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamOne.team.publicId,
    resourceType: "project",
    resourceId: "missing-project",
    permission: "viewer",
  }));
  assert.equal(missingTarget.status, 404);

  const afterDirectGrantCount = Number(
    (await database.prepare("SELECT COUNT(*) AS count FROM access_grants").first<{ count: number }>())?.count ?? 0,
  );
  assert.equal(afterDirectGrantCount, directGrantCount);

  configureActorResolverForTests(async () => recipientActor);
  const exactTask = await loadAccessibleTask(recipient.id, firstTask.id);
  assert.equal(exactTask.id, firstTask.id);
  assert.equal(exactTask.projectId, project.id);
  await assert.rejects(loadAccessibleTask(recipient.id, siblingTask.id), /tasks? were? not found/i);
  await assert.rejects(loadAccessibleProject(recipient.id, project.id), /Project not found/i);
  const exactTaskSnapshot = await getSnapshot(recipient);
  assert.ok(exactTaskSnapshot.users.some((user) => user.id === teamOwnerOne.id));
  assert.ok(exactTaskSnapshot.tasks.some((task) => task.id === firstTask.id));
  assert.equal(exactTaskSnapshot.tasks.some((task) => task.id === siblingTask.id), false);
  assert.equal(exactTaskSnapshot.projects.some((item) => item.id === project.id), false);
  const exactTaskTeamCollaborators = exactTaskSnapshot.collaborators.filter((collaborator) =>
    collaborator.source === "team"
  );
  assert.ok(exactTaskTeamCollaborators.some((collaborator) =>
    collaborator.resourceType === "task" &&
    collaborator.resourceId === firstTask.id &&
    collaborator.userId === teamOwnerOne.id
  ));
  assert.equal(exactTaskTeamCollaborators.some((collaborator) =>
    collaborator.resourceType === "project" || collaborator.resourceId === siblingTask.id
  ), false);
  const agentWorkspace = await getAgentWorkspace({
    authorizationId: "team-grants-agent",
    authorizationType: "personal_token",
    clientId: "team-grants-agent",
    scopes: ["api:read", "api:write"] as Array<"api:read" | "api:write">,
    user: recipient,
    expiresAt: null,
    resource: null,
  });
  assert.equal(agentWorkspace.counts.projects, 0);
  assert.ok(agentWorkspace.statuses.some((status) => status.name === "Team grant project status"));
  const agentTaskDetail = await getAgentTaskDetail(recipient, firstTask.publicId);
  assert.ok(agentTaskDetail.availableStatuses.some((status) => status.name === "Team grant project status"));
  const agentLabels = await listAgentLabels(recipient);
  assert.ok(agentLabels.items.some((label) => label.name === "Team grant project label"));
  assert.equal((await loadAccessibleView(recipient.id, globalView.id)).id, globalView.id);
  await assert.rejects(loadAccessibleView(recipient.id, projectView.id), /View not found/i);
  const globalIntersectionBeforeProject = await queryTaskSummaries(recipient, {
    surface: `view:${globalView.id}`,
  });
  assert.deepEqual(globalIntersectionBeforeProject.taskIds, [firstTask.id]);

  configureActorResolverForTests(async () => grantActor);
  const projectEditorResponse = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamOne.team.publicId,
    resourceType: "project",
    resourceId: project.id,
    permission: "editor",
  }));
  assert.equal(projectEditorResponse.status, 200);
  const projectEditor = await json<{ grant: TeamGrant }>(projectEditorResponse);
  const projectViewerResponse = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamTwo.team.publicId,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
  }));
  assert.equal(projectViewerResponse.status, 200);
  const projectViewer = await json<{ grant: TeamGrant }>(projectViewerResponse);

  configureActorResolverForTests(async () => recipientActor);
  const effectiveProject = await loadAccessibleProject(recipient.id, project.id);
  assert.equal(effectiveProject.accessRole, "editor");
  assert.equal((await loadAccessibleRelease(recipient.id, release.id)).accessRole, "editor");
  assert.equal((await getTask(recipient, siblingTask.id)).accessRole, "editor");
  assert.equal((await loadAccessibleView(recipient.id, projectView.id)).id, projectView.id);
  const globalIntersectionAfterProject = await queryTaskSummaries(recipient, {
    surface: `view:${globalView.id}`,
  });
  assert.deepEqual(
    new Set(globalIntersectionAfterProject.taskIds),
    new Set([firstTask.id, siblingTask.id]),
  );
  const search = await searchWorkspace(recipient, {
    query: "Team grant sibling task",
    limit: 20,
  });
  assert.ok(search.groups.tasks.some((item) => item.id === siblingTask.id));
  const snapshot = await getSnapshot(recipient);
  assert.ok(snapshot.projects.some((item) => item.id === project.id));
  assert.ok(snapshot.tasks.some((item) => item.id === siblingTask.id));
  const projectTeamCollaborators = snapshot.collaborators.filter((collaborator) =>
    collaborator.source === "team" &&
    collaborator.resourceType === "project" &&
    collaborator.resourceId === project.id
  );
  assert.ok(projectTeamCollaborators.some((collaborator) => collaborator.userId === teamOwnerOne.id));
  assert.ok(projectTeamCollaborators.some((collaborator) => collaborator.userId === teamOwnerTwo.id));
  assert.ok(snapshot.collaborators.some((collaborator) =>
    collaborator.source === "direct" &&
    collaborator.resourceType === "project" &&
    collaborator.resourceId === project.id &&
    collaborator.userId === actor.id
  ));

  const editorTask = await getTask(recipient, siblingTask.id);
  const updatedTask = await updateTask(recipient, siblingTask.id, {
    version: editorTask.version,
    title: "Team grant editor update",
  });
  assert.equal(updatedTask.title, "Team grant editor update");

  configureActorResolverForTests(async () => resourceOwnerActor);
  const managerResponse = await patchTeamGrant(
    jsonRequest("PATCH", "/api/team-grants/grant", {
      version: projectEditor.grant.version,
      permission: "manager",
    }),
    params({ id: projectEditor.grant.id }),
  );
  assert.equal(managerResponse.status, 200);
  const projectManager = await json<{ grant: TeamGrant }>(managerResponse);
  assert.equal(projectManager.grant.permission, "manager");
  assert.equal(projectManager.grant.version, 2);
  const stalePatch = await patchTeamGrant(
    jsonRequest("PATCH", "/api/team-grants/grant", {
      version: projectEditor.grant.version,
      permission: "viewer",
    }),
    params({ id: projectEditor.grant.id }),
  );
  assert.equal(stalePatch.status, 409);

  const revokeResponse = await revokeTeamGrant(
    jsonRequest("DELETE", "/api/team-grants/grant", { version: projectManager.grant.version }),
    params({ id: projectManager.grant.id }),
  );
  assert.equal(revokeResponse.status, 200);
  const revokedProjectGrant = await json<{ grant: TeamGrant }>(revokeResponse);
  assert.equal(revokedProjectGrant.grant.revokedAt !== null, true);
  assert.equal(revokedProjectGrant.grant.version, 3);

  const grantsWithRevoked = await listTeamGrants(
    new Request(
      `https://example.test/api/team-grants?resourceType=project&resourceId=${project.id}&includeRevoked=1`,
    ),
  );
  assert.equal(grantsWithRevoked.status, 200);
  const grantsWithRevokedBody = await json<{ grants: TeamGrant[] }>(grantsWithRevoked);
  assert.ok(grantsWithRevokedBody.grants.some((grant) =>
    grant.id === revokedProjectGrant.grant.id &&
    grant.version === revokedProjectGrant.grant.version &&
    grant.revokedAt !== null
  ));

  configureActorResolverForTests(async () => recipientActor);
  const strongestAfterRevoke = await loadAccessibleProject(recipient.id, project.id);
  assert.equal(strongestAfterRevoke.accessRole, "viewer");
  const viewerTask = await getTask(recipient, siblingTask.id);
  await assert.rejects(
    updateTask(recipient, siblingTask.id, {
      version: viewerTask.version,
      title: "Viewer must not mutate",
    }),
    /Editor access is required/i,
  );

  configureActorResolverForTests(async () => grantActor);
  const reactivatedResponse = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamOne.team.publicId,
    resourceType: "project",
    resourceId: project.id,
    permission: "editor",
    version: revokedProjectGrant.grant.version,
  }));
  assert.equal(reactivatedResponse.status, 200);
  const reactivatedProjectGrant = await json<{ grant: TeamGrant }>(reactivatedResponse);
  assert.equal(reactivatedProjectGrant.grant.revokedAt, null);
  assert.equal(reactivatedProjectGrant.grant.permission, "editor");
  assert.equal(reactivatedProjectGrant.grant.version, 4);

  configureActorResolverForTests(async () => teamOwnerOneActor);
  const inactiveOne = await updateTeamMembership(
    teamOwnerOne,
    teamOne.team.publicId,
    recipientMembershipOne.membership.id,
    { status: "inactive", version: recipientMembershipOne.membership.version },
  );
  configureActorResolverForTests(async () => teamOwnerTwoActor);
  const inactiveTwo = await updateTeamMembership(
    teamOwnerTwo,
    teamTwo.team.publicId,
    recipientMembershipTwo.membership.id,
    { status: "inactive", version: recipientMembershipTwo.membership.version },
  );
  configureActorResolverForTests(async () => recipientActor);
  await assert.rejects(loadAccessibleProject(recipient.id, project.id), /Project not found/i);
  configureActorResolverForTests(async () => resourceOwnerActor);
  const inactiveMembershipSnapshot = await getSnapshot(resourceOwner);
  assert.equal(inactiveMembershipSnapshot.collaborators.some((collaborator) =>
    collaborator.source === "team" && collaborator.userId === recipient.id
  ), false);
  configureActorResolverForTests(async () => teamOwnerOneActor);
  await updateTeamMembership(
    teamOwnerOne,
    teamOne.team.publicId,
    recipientMembershipOne.membership.id,
    { status: "active", version: inactiveOne.membership.version },
  );
  configureActorResolverForTests(async () => teamOwnerTwoActor);
  await updateTeamMembership(
    teamOwnerTwo,
    teamTwo.team.publicId,
    recipientMembershipTwo.membership.id,
    { status: "active", version: inactiveTwo.membership.version },
  );

  configureActorResolverForTests(async () => resourceOwnerActor);
  const revokeReactivatedProjectGrant = await revokeTeamGrant(
    jsonRequest("DELETE", "/api/team-grants/grant", {
      version: reactivatedProjectGrant.grant.version,
    }),
    params({ id: reactivatedProjectGrant.grant.id }),
  );
  assert.equal(revokeReactivatedProjectGrant.status, 200);
  const revokedReactivatedProjectGrant = await json<{ grant: TeamGrant }>(revokeReactivatedProjectGrant);
  configureActorResolverForTests(async () => grantActor);
  const revokeRemainingProjectViewer = await revokeTeamGrant(
    jsonRequest("DELETE", "/api/team-grants/grant", {
      version: projectViewer.grant.version,
    }),
    params({ id: projectViewer.grant.id }),
  );
  assert.equal(revokeRemainingProjectViewer.status, 200);

  const directCountBeforeRecipient = Number(
    (await database.prepare("SELECT COUNT(*) AS count FROM access_grants").first<{ count: number }>())?.count ?? 0,
  );
  await grantAccess(resourceOwner, {
    resourceType: "project",
    resourceId: project.id,
    email: recipient.email,
    permission: "editor",
  });
  const directProjectGrant = await database
    .prepare(
      `SELECT owner_user_id, grantee_user_id, permission, revoked_at
       FROM access_grants
       WHERE resource_type = 'project' AND resource_id = ? AND grantee_user_id = ?`,
    )
    .bind(project.id, recipient.id)
    .first<{ owner_user_id: string; grantee_user_id: string; permission: string; revoked_at: string | null }>();
  assert.deepEqual(directProjectGrant, {
    owner_user_id: resourceOwner.id,
    grantee_user_id: recipient.id,
    permission: "editor",
    revoked_at: null,
  });
  assert.equal(
    Number((await database.prepare("SELECT COUNT(*) AS count FROM access_grants").first<{ count: number }>())?.count ?? 0),
    directCountBeforeRecipient + 1,
  );

  configureActorResolverForTests(async () => grantActor);
  const teamViewerAfterDirectResponse = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamOne.team.publicId,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
    version: revokedReactivatedProjectGrant.grant.version,
  }));
  assert.equal(teamViewerAfterDirectResponse.status, 200);
  const teamViewerAfterDirect = await json<{ grant: TeamGrant }>(teamViewerAfterDirectResponse);
  assert.equal(teamViewerAfterDirect.grant.permission, "viewer");

  configureActorResolverForTests(async () => recipientActor);
  assert.equal((await loadAccessibleProject(recipient.id, project.id)).accessRole, "editor");

  configureActorResolverForTests(async () => resourceOwnerActor);
  const revokedTeamViewer = await revokeTeamGrant(
    jsonRequest("DELETE", "/api/team-grants/grant", {
      version: teamViewerAfterDirect.grant.version,
    }),
    params({ id: teamViewerAfterDirect.grant.id }),
  );
  assert.equal(revokedTeamViewer.status, 200);
  const revokedTeamViewerGrant = await json<{ grant: TeamGrant }>(revokedTeamViewer);
  configureActorResolverForTests(async () => recipientActor);
  assert.equal((await loadAccessibleProject(recipient.id, project.id)).accessRole, "editor");

  configureActorResolverForTests(async () => resourceOwnerActor);
  const listed = await listTeamGrants(
    new Request(`https://example.test/api/team-grants?teamId=${teamOne.team.publicId}`),
  );
  assert.equal(listed.status, 200);
  const listedBody = await json<{ grants: TeamGrant[] }>(listed);
  assert.ok(listedBody.grants.some((grant) => grant.id === globalViewGrant.grant.id));
  assert.equal(listedBody.grants.some((grant) => grant.id === revokedProjectGrant.grant.id), false);
  assert.equal(listedBody.grants.every((grant) => grant.revokedAt === null), true);

  configureActorResolverForTests(async () => teamOwnerOneActor);
  await updateTeamMembership(
    teamOwnerOne,
    teamOne.team.publicId,
    resourceOwnerMembershipOne.membership.id,
    { status: "inactive", version: resourceOwnerMembershipOne.membership.version },
  );
  configureActorResolverForTests(async () => resourceOwnerActor);
  const resourceScoped = await listTeamGrants(
    new Request(
      `https://example.test/api/team-grants?resourceType=saved_view&resourceId=${globalView.id}`,
    ),
  );
  assert.equal(resourceScoped.status, 200);
  const resourceScopedBody = await json<{ grants: TeamGrant[] }>(resourceScoped);
  assert.deepEqual(
    resourceScopedBody.grants.map((grant) => grant.id),
    [globalViewGrant.grant.id],
  );
  assert.equal(resourceScopedBody.grants[0]?.revokedAt, null);

  configureActorResolverForTests(async () => grantActor);
  const reactivateWithoutVersion = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamOne.team.publicId,
    resourceType: "project",
    resourceId: project.id,
    permission: "editor",
  }));
  assert.equal(reactivateWithoutVersion.status, 400);
  const reactivatedWithVersion = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamOne.team.publicId,
    resourceType: "project",
    resourceId: project.id,
    permission: "editor",
    version: revokedTeamViewerGrant.grant.version,
  }));
  assert.equal(reactivatedWithVersion.status, 200);
  const reactivatedWithVersionGrant = await json<{ grant: TeamGrant }>(reactivatedWithVersion);
  const roleChangeWithoutVersion = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamOne.team.publicId,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
  }));
  assert.equal(roleChangeWithoutVersion.status, 400);
  const roleChangeWithVersion = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamOne.team.publicId,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
    version: reactivatedWithVersionGrant.grant.version,
  }));
  assert.equal(roleChangeWithVersion.status, 200);
  const roleChangeWithVersionGrant = await json<{ grant: TeamGrant }>(roleChangeWithVersion);

  configureActorResolverForTests(async () => grantActor);
  const cleanupProjectGrant = await revokeTeamGrant(
    jsonRequest("DELETE", "/api/team-grants/grant", {
      version: roleChangeWithVersionGrant.grant.version,
    }),
    params({ id: roleChangeWithVersionGrant.grant.id }),
  );
  assert.equal(cleanupProjectGrant.status, 200);

  configureActorResolverForTests(async () => outsiderActor);
  const outsiderTarget = await createTeamGrant(jsonRequest("POST", "/api/team-grants", {
    teamId: teamOne.team.publicId,
    resourceType: "project",
    resourceId: project.id,
    permission: "viewer",
  }));
  const outsiderUnknown = await listTeamGrants(
    new Request("https://example.test/api/team-grants?teamId=missing-team"),
  );
  assert.equal(outsiderTarget.status, 404);
  assert.equal(outsiderUnknown.status, 404);
  assert.equal(
    (await outsiderTarget.clone().json() as { error: string }).error,
    (await outsiderUnknown.json() as { error: string }).error,
  );
  const outsiderResource = await listTeamGrants(
    new Request(
      `https://example.test/api/team-grants?resourceType=saved_view&resourceId=${globalView.id}`,
    ),
  );
  const unknownResource = await listTeamGrants(
    new Request(
      "https://example.test/api/team-grants?resourceType=saved_view&resourceId=missing-view",
    ),
  );
  assert.equal(outsiderResource.status, 404);
  assert.equal(unknownResource.status, 404);
  assert.equal(
    (await outsiderResource.clone().json() as { error: string }).error,
    (await unknownResource.json() as { error: string }).error,
  );

  const finalDirectGrantCount = Number(
    (await database.prepare("SELECT COUNT(*) AS count FROM access_grants").first<{ count: number }>())?.count ?? 0,
  );
  assert.equal(finalDirectGrantCount, directGrantCount + 1);
});

type TeamGrant = {
  id: string;
  permission: string;
  version: number;
  revokedAt: string | null;
};

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function jsonRequest(method: string, url: string, body: Record<string, unknown>): Request {
  return new Request(`https://example.test${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(value: { id: string }) {
  return { params: Promise.resolve(value) };
}
