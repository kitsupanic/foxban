import { Hono } from "hono";
import { z } from "zod";
import { BoardAccessModeSchema, type BoardAccessMode, type WorkspaceRole } from "@foxban/shared";

import { ACCESS_CHANGE_ABORT, ACCESS_CONFLICT, AccessChangeConflict, INVITER_IS_ADMIN, type AccessChangeResult, resolveAccessChangeAttempt, runAccessChange, sendPresenceInvalidate } from "./access-changes";
import { boardOpenSql, createInviteToken, isAdminEmail, rateLimitLookup, requireAdmin, requireAuth, sha256Hex, type AppEnv, type SessionUser } from "./auth";

const WorkspaceNameSchema = z.string().trim().min(1).max(40);
const OperationIdSchema = z.string().uuid();
const CreateSchema = z.strictObject({ name: WorkspaceNameSchema });
const SettingsSchema = z.strictObject({ name: WorkspaceNameSchema.optional(), defaultBoardAccess: BoardAccessModeSchema.optional() }).refine((v)=>v.name!==undefined||v.defaultBoardAccess!==undefined);
const RoleSchema = z.strictObject({ role: z.enum(["admin","member"]), operationId: OperationIdSchema });
const AddMemberSchema = z.strictObject({ userId: z.string().min(1).max(64), role: z.enum(["admin","member"]).default("member"), operationId: OperationIdSchema });
const RemoveSchema = z.strictObject({ operationId: OperationIdSchema });
const InviteCreateSchema = z.strictObject({ role: z.enum(["member","admin"]).default("member") });
const InviteTokenSchema = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), operationId: OperationIdSchema.optional() });
const INVITE_UNAVAILABLE = { code:"workspace_invite_unavailable", error:"This workspace invitation is unavailable." } as const;
const DAY_MS = 86_400_000;
// A membership that is already there changes nothing, so it runs no access change: that would close every socket of every board for a no-op.
const alreadyMember=(operationId:string,result:unknown):AccessChangeResult=>({operationId,state:"completed",outcome:"committed",result});
// A member already, and no access change holds the workspace: one in flight (a removal, say) may still change that, so it goes through runAccessChange and its conflict.
const isSettledMember=async(env:Env,workspaceId:string,userId:string)=>!!await env.DB.prepare(`SELECT 1 AS present FROM workspace_members WHERE workspace_id=? AND user_id=? AND NOT EXISTS(SELECT 1 FROM access_change_scopes WHERE workspace_id=?)`).bind(workspaceId,userId,workspaceId).first();

type WorkspaceRecord = { id:string;name:string;defaultBoardAccess:BoardAccessMode;role:WorkspaceRole|null;createdAt:number;updatedAt:number };
type InviteRecord = { id:string;workspaceId:string;role:"member"|"admin";invitedBy:string;createdAt:number;expiresAt:number;revokedAt:number|null };

async function workspaceRecord(env:Env,userId:string,id:string):Promise<WorkspaceRecord|null>{
  return env.DB.prepare(`SELECT w.id,w.name,w.default_board_access AS defaultBoardAccess,wm.role,w.created_at AS createdAt,w.updated_at AS updatedAt FROM workspaces w LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=? WHERE w.id=?`).bind(userId,id).first<WorkspaceRecord>();
}
async function requireWorkspaceAdmin(env:Env,userId:string,id:string):Promise<WorkspaceRecord|null>{
  const row=await workspaceRecord(env,userId,id); return row?.role==="admin"?row:null;
}
const WORKSPACE_NOT_EMPTY = { code:"workspace_not_empty", error:"Move or delete this workspace's boards first." } as const;
const LAST_ADMIN = { code:"last_admin", error:"A workspace needs at least one admin. Promote another member to admin first." } as const;
/** Whether `userId` is the only admin left, so demoting or removing them would leave the workspace with none. */
async function isLastAdmin(env:Env,workspaceId:string,userId:string):Promise<boolean>{
  return await env.DB.prepare(`SELECT 1 AS present FROM workspace_members t WHERE t.workspace_id=? AND t.user_id=? AND t.role='admin' AND NOT EXISTS(SELECT 1 FROM workspace_members o WHERE o.workspace_id=t.workspace_id AND o.role='admin' AND o.user_id<>t.user_id)`).bind(workspaceId,userId).first()!==null;
}
type WorkspaceView = { id:string;name:string;defaultBoardAccess:BoardAccessMode;role:WorkspaceRole|null;access:"member"|"operator"|"guest";boardCount:number;createdAt:number;updatedAt:number };

/**
 * The workspace as one authorized view of it: the viewer's current role, access
 * class and the count of boards they may discover, read back from D1 in a single
 * query rather than assembled from an earlier request-time read. The same predicate
 * answers the list and a write's response, so a membership removed while the request
 * was in flight cannot be answered with the role that request started with, and a
 * client that just changed a setting sees what it actually got. `null` means there
 * is no such workspace.
 */
async function workspaceView(env:Env,user:SessionUser,workspaceId:string):Promise<WorkspaceView|null>{
  const operator=isAdminEmail(env,user.email)?1:0;
  return env.DB.prepare(`SELECT w.id,w.name,w.default_board_access AS defaultBoardAccess,wm.role,
      CASE WHEN wm.user_id IS NOT NULL THEN 'member' WHEN ?=1 THEN 'operator' ELSE 'guest' END AS access,
      COUNT(DISTINCT b.id) AS boardCount,w.created_at AS createdAt,w.updated_at AS updatedAt
      FROM workspaces w
      LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=?
      LEFT JOIN boards b ON b.workspace_id=w.id AND ${boardOpenSql("b","?","(?=1 AND wm.user_id IS NULL)")}
     WHERE w.id=?
     GROUP BY w.id`).bind(operator,user.id,operator,user.id,user.id,user.id,workspaceId).first<WorkspaceView>();
}

export const workspacesRouter = new Hono<AppEnv>()
  .use("*",requireAuth)
  .get("/",async(c)=>{
    const user=c.get("user");
    // Discovery follows membership or a board the viewer holds as a member or a
    // Guest. An instance Admin is no exception: other people's workspaces come
    // only from the explicit `/all` read below. A membership whose every board is
    // restricted and uninvited still lists the workspace with a zero count, because
    // the member can create boards there and the sidebar must not lose it.
    const {results}=await c.env.DB.prepare(`SELECT w.id,w.name,w.default_board_access AS defaultBoardAccess,wm.role,
      CASE WHEN wm.user_id IS NOT NULL THEN 'member' ELSE 'guest' END AS access,
      COUNT(DISTINCT b.id) AS boardCount,w.created_at AS createdAt,w.updated_at AS updatedAt
      FROM workspaces w
      LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=?
      LEFT JOIN boards b ON b.workspace_id=w.id AND ${boardOpenSql("b","?")}
     WHERE wm.user_id IS NOT NULL OR b.id IS NOT NULL
     GROUP BY w.id
     ORDER BY w.created_at,w.id`).bind(user.id,user.id,user.id,user.id).all();
    return c.json({workspaces:results});
  })
  // Instance-wide read for Admins only (the All workspaces page). It is its own route,
  // declared before `/:workspaceId`, so nothing about the default list above can widen it.
  // shortcut: unpaginated, an instance serves one group of people; page it if that stops holding.
  .get("/all",requireAdmin,async(c)=>{
    const {results}=await c.env.DB.prepare(`SELECT w.id,w.name,w.default_board_access AS defaultBoardAccess,wm.role,
      CASE WHEN wm.user_id IS NOT NULL THEN 'member' ELSE 'operator' END AS access,
      (SELECT COUNT(*) FROM boards b WHERE b.workspace_id=w.id) AS boardCount,w.created_at AS createdAt,w.updated_at AS updatedAt,
      u.name AS createdBy
      FROM workspaces w
      LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=?
      LEFT JOIN users u ON u.id=w.owner_id
     ORDER BY w.created_at,w.id`).bind(c.get("user").id).all<WorkspaceView&{createdBy:string|null}>();
    return c.json({workspaces:results});
  })
  .post("/",async(c)=>{
    const parsed=CreateSchema.safeParse(await c.req.json().catch(()=>null)); if(!parsed.success)return c.json({error:"invalid request"} as const,400);
    const user=c.get("user"),now=Date.now(),id=crypto.randomUUID();
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO workspaces(id,name,owner_id,default_board_access,created_at,updated_at) VALUES(?,?,?,'workspace',?,?)`).bind(id,parsed.data.name,user.id,now,now),
      c.env.DB.prepare(`INSERT INTO workspace_members(workspace_id,user_id,role,created_at,updated_at) VALUES(?,?,'admin',?,?)`).bind(id,user.id,now,now),
    ]);
    return c.json({workspace:{id,name:parsed.data.name,defaultBoardAccess:"workspace",role:"admin",access:"member",boardCount:0,createdAt:now,updatedAt:now}},201);
  })
  .get("/:workspaceId",async(c)=>{
    const id=c.req.param("workspaceId"),user=c.get("user");
    const view=await workspaceView(c.env,user,id);
    // The viewer's state as it stands now decides: a membership removed while this
    // request was in flight reads as a guest with nothing discoverable, which is a
    // denial. The role this route started with never authorizes the answer it returns.
    if(!view||(!view.role&&!isAdminEmail(c.env,user.email)&&view.boardCount===0))return c.json({error:"forbidden"} as const,403);
    return c.json({workspace:view});
  })
  .patch("/:workspaceId",async(c)=>{
    const parsed=SettingsSchema.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:"invalid request"} as const,400);
    const id=c.req.param("workspaceId"),user=c.get("user"),now=Date.now();
    // The manager predicate rides the write: a role read before it could be
    // revoked while the request was in flight, and the answer below is the row
    // that actually landed rather than the values that were requested.
    const {meta}=await c.env.DB.prepare(`UPDATE workspaces SET name=COALESCE(?,name),default_board_access=COALESCE(?,default_board_access),updated_at=?
      WHERE id=? AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=workspaces.id AND wm.user_id=? AND wm.role='admin')
        AND NOT EXISTS(SELECT 1 FROM access_change_scopes WHERE workspace_id=?)`).bind(parsed.data.name??null,parsed.data.defaultBoardAccess??null,now,id,user.id,id).run();
    if(meta.changes!==1){
      const row=await workspaceRecord(c.env,user.id,id);
      if(row?.role!=="admin")return c.json({error:"forbidden"} as const,403);
      return c.json(ACCESS_CONFLICT,409);
    }
    const view=await workspaceView(c.env,user,id);
    if(!view)return c.json({error:"forbidden"} as const,403);
    return c.json({workspace:view});
  })
  .delete("/:workspaceId",async(c)=>{
    const id=c.req.param("workspaceId"),user=c.get("user");
    // One batch is one transaction. The first statement reads who is about to lose
    // the workspace. The second alone carries the authority and the emptiness check:
    // it is what a board created or moved in at the same moment races against, and it
    // sees either that board or the lock its move holds. The last two act only once
    // the workspace row is really gone, so a refused delete leaves its members and
    // invitations exactly as they were.
    const [members,deleted]=await c.env.DB.batch([
      c.env.DB.prepare(`SELECT user_id AS userId FROM workspace_members WHERE workspace_id=?`).bind(id),
      c.env.DB.prepare(`DELETE FROM workspaces WHERE id=? AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=workspaces.id AND wm.user_id=? AND wm.role='admin') AND NOT EXISTS(SELECT 1 FROM boards WHERE workspace_id=workspaces.id)
        AND NOT EXISTS(SELECT 1 FROM access_change_scopes WHERE workspace_id=workspaces.id)`).bind(id,user.id),
      c.env.DB.prepare(`DELETE FROM workspace_members WHERE workspace_id=? AND NOT EXISTS(SELECT 1 FROM workspaces WHERE id=?)`).bind(id,id),
      c.env.DB.prepare(`DELETE FROM workspace_invites WHERE workspace_id=? AND NOT EXISTS(SELECT 1 FROM workspaces WHERE id=?)`).bind(id,id),
    ]);
    if(deleted?.meta.changes!==1){
      if((await workspaceRecord(c.env,user.id,id))?.role!=="admin")return c.json({error:"forbidden"} as const,403);
      if(await c.env.DB.prepare(`SELECT 1 AS present FROM boards WHERE workspace_id=?`).bind(id).first())return c.json(WORKSPACE_NOT_EMPTY,409);
      return c.json(ACCESS_CONFLICT,409);
    }
    // A hint, not part of the delete: it is already done, and a person who misses the
    // frame sees the workspace go the next time their lists refresh.
    try{
      await sendPresenceInvalidate(c.env,(members?.results as {userId:string}[]).map(({userId})=>({userId,workspaceIds:[id],boardIds:[]})));
    }catch{}
    return c.json({ok:true} as const);
  })
  .get("/:workspaceId/members",async(c)=>{
    const id=c.req.param("workspaceId"),user=c.get("user");
    // The viewer's own membership row is the predicate for the directory itself,
    // so a removed or demoted actor reads nothing instead of a stale copy of the
    // member list. The viewer always has a row of their own to join through.
    const {results}=await c.env.DB.prepare(`SELECT u.id AS userId,u.email,u.name,u.github_login AS githubLogin,u.avatar_version AS avatarVersion,wm.role,wm.created_at AS createdAt,wm.updated_at AS updatedAt FROM workspace_members viewer JOIN workspace_members wm ON wm.workspace_id=viewer.workspace_id JOIN users u ON u.id=wm.user_id WHERE viewer.workspace_id=? AND viewer.user_id=? ORDER BY CASE wm.role WHEN 'admin' THEN 0 ELSE 1 END,u.name,u.id`).bind(id,user.id).all();if(results.length===0)return c.json({error:"forbidden"} as const,403);return c.json({members:results});
  })
  .post("/:workspaceId/members",async(c)=>{
    const parsed=AddMemberSchema.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:"invalid request"} as const,400);
    const id=c.req.param("workspaceId"),actor=c.get("user"),role=parsed.data.role;
    try{
      // An attempt with this id is answered from the journal first, and it is bound
      // to the role it was issued for: a lost response replays its recorded
      // resolution instead of re-deriving one from a later request.
      const resumed=await resolveAccessChangeAttempt(c.env,actor,parsed.data.operationId,"workspace-member-add",{workspaceId:id,userId:parsed.data.userId,role});
      if(resumed){
        if(resumed.state!=="completed")return c.json(resumed,202);
        return resumed.outcome==="aborted"?c.json({error:resumed.result===ACCESS_CHANGE_ABORT.memberNotFound?"user not found":"forbidden"} as const,resumed.result===ACCESS_CHANGE_ABORT.memberNotFound?404:403):c.json(resumed);
      }
      const workspace=await requireWorkspaceAdmin(c.env,actor.id,id);if(!workspace)return c.json({error:"forbidden"} as const,403);
      // Only an account that already exists can be added. The reservation re-asserts
      // this while the workspace lock is held, so a name that vanished in between
      // cannot be granted a membership.
      if(!await c.env.DB.prepare(`SELECT 1 AS present FROM users WHERE id=?`).bind(parsed.data.userId).first())return c.json({error:"user not found"} as const,404);
      if(await isSettledMember(c.env,id,parsed.data.userId))return c.json(alreadyMember(parsed.data.operationId,{workspaceId:id,userId:parsed.data.userId}));
      // Every board of this workspace is fenced: the new member reaches the Workspace
      // boards (and, as an admin, the Private ones) the moment the membership commits.
      const result=await runAccessChange(c.env,actor,{operationId:parsed.data.operationId,kind:"workspace-member-add",payload:{workspaceId:id,userId:parsed.data.userId,role},workspaceIds:[id],inheritWorkspaceBoards:true});
      if(result.state!=="completed")return c.json(result,202);
      if(result.outcome==="aborted")return c.json({error:result.result===ACCESS_CHANGE_ABORT.memberNotFound?"user not found":"forbidden"} as const,result.result===ACCESS_CHANGE_ABORT.memberNotFound?404:403);
      return c.json(result);
    }catch(e){if(e instanceof AccessChangeConflict)return c.json(ACCESS_CONFLICT,409);throw e;}
  })
  .get("/:workspaceId/membership-candidates",rateLimitLookup,async(c)=>{
    const id=c.req.param("workspaceId"),user=c.get("user"),email=(c.req.query("email")??"").trim().toLowerCase();
    // One authorization-bearing read: the viewer's own membership row is the
    // predicate, so a manager demoted or removed before this statement ran reads
    // nothing instead of what their old role allowed. This is no directory (ADR 0072):
    // it answers only for one exact address, and never for an account that already
    // holds a membership, so the list cannot offer someone the member list already shows.
    // Only public identity columns leave the server.
    const {results}=email===""?{results:[]}:await c.env.DB.prepare(
      `SELECT u.id,u.email,u.name,u.github_login AS githubLogin,u.avatar_version AS avatarVersion
         FROM workspace_members viewer
         JOIN users u ON u.id<>viewer.user_id AND u.email=?
        WHERE viewer.workspace_id=? AND viewer.user_id=? AND viewer.role='admin'
          AND NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=viewer.workspace_id AND m.user_id=u.id)`).bind(email,id,user.id).all();
    // An empty answer is a legitimate one, so denial is only claimed once the
    // manager read disagrees — the distinction the invite list makes as well.
    if(results.length===0&&!await requireWorkspaceAdmin(c.env,user.id,id))return c.json({error:"forbidden"} as const,403);
    return c.json({candidates:results});
  })
  .patch("/:workspaceId/members/:userId",async(c)=>{
    const parsed=RoleSchema.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:"invalid request"} as const,400);const id=c.req.param("workspaceId"),target=c.req.param("userId"),actor=c.get("user");
    try{
      // An attempt with this id is answered from the journal first: a lost response
      // must replay its recorded outcome even if the caller's own role has since
      // changed, and the id must never be reused for a different mutation.
      const resumed=await resolveAccessChangeAttempt(c.env,actor,parsed.data.operationId,"workspace-member-role",{workspaceId:id,userId:target,role:parsed.data.role});
      const refused=(reason:unknown)=>reason===ACCESS_CHANGE_ABORT.lastAdmin?c.json(LAST_ADMIN,409):reason===ACCESS_CHANGE_ABORT.forbidden?c.json({error:"forbidden"} as const,403):c.json({error:"member not found"} as const,404);
      if(resumed)return resumed.state!=="completed"?c.json(resumed,202):(resumed.outcome==="aborted"?refused(resumed.result):c.json(resumed));
      const workspace=await requireWorkspaceAdmin(c.env,actor.id,id);if(!workspace)return c.json({error:"forbidden"} as const,403);
      // The same rule the commit and the database enforce, applied first so the person is told what to do.
      if(parsed.data.role==="member"&&await isLastAdmin(c.env,id,target))return c.json(LAST_ADMIN,409);
      const result=await runAccessChange(c.env,actor,{operationId:parsed.data.operationId,kind:"workspace-member-role",payload:{workspaceId:id,userId:target,role:parsed.data.role},workspaceIds:[id],inheritWorkspaceBoards:true});
      if(result.state!=="completed")return c.json(result,202);
      if(result.outcome==="aborted")return refused(result.result);
      return c.json(result);
    }catch(e){if(e instanceof AccessChangeConflict)return c.json(ACCESS_CONFLICT,409);throw e;}
  })
  .delete("/:workspaceId/members/:userId",async(c)=>{
    const parsed=RemoveSchema.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:"invalid request"} as const,400);const id=c.req.param("workspaceId"),target=c.req.param("userId"),actor=c.get("user");
    try{
      const resumed=await resolveAccessChangeAttempt(c.env,actor,parsed.data.operationId,"workspace-member-remove",{workspaceId:id,userId:target});
      const refused=(reason:unknown)=>reason===ACCESS_CHANGE_ABORT.lastAdmin?c.json(LAST_ADMIN,409):reason===ACCESS_CHANGE_ABORT.forbidden?c.json({error:"forbidden"} as const,403):c.json(ACCESS_CONFLICT,409);
      if(resumed){
        if(resumed.state!=="completed")return c.json(resumed,202);
        return resumed.outcome==="aborted"?refused(resumed.result):c.json(resumed);
      }
      // An admin removes anyone; any member removes themselves, which is leaving.
      const self=await workspaceRecord(c.env,actor.id,id);if(self?.role!=="admin"&&!(self?.role&&target===actor.id))return c.json({error:"forbidden"} as const,403);
      if(await isLastAdmin(c.env,id,target))return c.json(LAST_ADMIN,409);
      const result=await runAccessChange(c.env,actor,{operationId:parsed.data.operationId,kind:"workspace-member-remove",payload:{workspaceId:id,userId:target},workspaceIds:[id],inheritWorkspaceBoards:true});
      if(result.state!=="completed")return c.json(result,202);
      if(result.outcome==="aborted")return refused(result.result);
      return c.json(result);
    }catch(e){if(e instanceof AccessChangeConflict)return c.json(ACCESS_CONFLICT,409);throw e;}
  })
  .get("/:workspaceId/invites",async(c)=>{const id=c.req.param("workspaceId"),user=c.get("user");const {results}=await c.env.DB.prepare(`SELECT wi.id,wi.role,wi.invited_by AS invitedBy,wi.created_at AS createdAt,wi.expires_at AS expiresAt FROM workspace_invites wi JOIN workspace_members wm ON wm.workspace_id=wi.workspace_id AND wm.user_id=? AND wm.role='admin' WHERE wi.workspace_id=? AND wi.revoked_at IS NULL AND wi.expires_at>? AND ${INVITER_IS_ADMIN} ORDER BY wi.created_at,wi.id`).bind(user.id,id,Date.now()).all();if(results.length===0&&!await requireWorkspaceAdmin(c.env,user.id,id))return c.json({error:"forbidden"} as const,403);return c.json({invites:results});})
  .post("/:workspaceId/invites",async(c)=>{const parsed=InviteCreateSchema.safeParse(await c.req.json().catch(()=>({})));if(!parsed.success)return c.json({error:"invalid request"} as const,400);const id=c.req.param("workspaceId"),actor=c.get("user");const token=createInviteToken(),now=Date.now(),invite={id:crypto.randomUUID(),role:parsed.data.role,invitedBy:actor.id,createdAt:now,expiresAt:now+7*DAY_MS};
    // The manager predicate and the transition lock are part of the insert: the
    // token is only returned when its row is really there, so an issuance that
    // raced a membership change can never hand out a link that grants nothing.
    const {meta}=await c.env.DB.prepare(`INSERT INTO workspace_invites(id,workspace_id,role,token_hash,invited_by,created_at,expires_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=? AND wm.user_id=? AND wm.role='admin')
        AND NOT EXISTS(SELECT 1 FROM access_change_scopes WHERE workspace_id=?)`).bind(invite.id,id,invite.role,await sha256Hex(token),actor.id,now,invite.expiresAt,id,actor.id,id).run();
    if(meta.changes!==1){
      if(!await requireWorkspaceAdmin(c.env,actor.id,id))return c.json({error:"forbidden"} as const,403);
      return c.json(ACCESS_CONFLICT,409);
    }
    return c.json({invite,token},201);})
  .delete("/:workspaceId/invites/:inviteId",async(c)=>{const id=c.req.param("workspaceId"),inviteId=c.req.param("inviteId"),user=c.get("user");
    const {meta}=await c.env.DB.prepare(`UPDATE workspace_invites SET revoked_at=? WHERE id=? AND workspace_id=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=workspace_invites.workspace_id AND wm.user_id=? AND wm.role='admin') AND NOT EXISTS(SELECT 1 FROM access_change_scopes WHERE workspace_id=?)`).bind(Date.now(),inviteId,id,user.id,id).run();
    if(meta.changes===1)return c.json({ok:true} as const);
    if(!await requireWorkspaceAdmin(c.env,user.id,id))return c.json({error:"forbidden"} as const,403);
    if(await c.env.DB.prepare(`SELECT 1 AS present FROM access_change_scopes WHERE workspace_id=?`).bind(id).first())return c.json(ACCESS_CONFLICT,409);
    if(!await c.env.DB.prepare(`SELECT 1 AS present FROM workspace_invites WHERE id=? AND workspace_id=?`).bind(inviteId,id).first())return c.json({error:"invite not found"} as const,404);
    // The row exists but was already revoked or expired: there is nothing left to
    // revoke, which is the outcome the caller asked for.
    return c.json({ok:true} as const);})
  .post("/:workspaceId/invites/inspect",async(c)=>{const parsed=InviteTokenSchema.omit({operationId:true}).safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json(INVITE_UNAVAILABLE,400);const id=c.req.param("workspaceId"),invite=await c.env.DB.prepare(`SELECT wi.id,wi.workspace_id AS workspaceId,wi.role,wi.invited_by AS invitedBy,wi.created_at AS createdAt,wi.expires_at AS expiresAt,wi.revoked_at AS revokedAt,w.name AS workspaceName FROM workspace_invites wi JOIN workspaces w ON w.id=wi.workspace_id WHERE wi.workspace_id=? AND wi.token_hash=? AND wi.revoked_at IS NULL AND wi.expires_at>? AND ${INVITER_IS_ADMIN}`).bind(id,await sha256Hex(parsed.data.token),Date.now()).first<InviteRecord&{workspaceName:string}>();if(!invite)return c.json(INVITE_UNAVAILABLE,400);return c.json({workspaceName:invite.workspaceName,role:invite.role,expiresAt:invite.expiresAt},{headers:{"Cache-Control":"no-store"}});})
  .post("/:workspaceId/invites/accept",async(c)=>{const parsed=InviteTokenSchema.required({operationId:true}).safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json(INVITE_UNAVAILABLE,400);const id=c.req.param("workspaceId"),actor=c.get("user"),hash=await sha256Hex(parsed.data.token);
   try{
     // A repeated acceptance with the same attempt id is answered from the journal:
     // the invite may already be consumed by that very attempt.
     const resumed=await resolveAccessChangeAttempt(c.env,actor,parsed.data.operationId,"workspace-invite-accept",{workspaceId:id,inviteHash:hash});
     if(resumed){if(resumed.state!=="completed")return c.json(resumed,202);return resumed.outcome==="aborted"?c.json(INVITE_UNAVAILABLE,400):c.json(resumed);}
     const invite=await c.env.DB.prepare(`SELECT wi.id,wi.workspace_id AS workspaceId,wi.role,wi.invited_by AS invitedBy,wi.created_at AS createdAt,wi.expires_at AS expiresAt,wi.revoked_at AS revokedAt FROM workspace_invites wi WHERE wi.workspace_id=? AND wi.token_hash=? AND wi.revoked_at IS NULL AND wi.expires_at>? AND ${INVITER_IS_ADMIN}`).bind(id,hash,Date.now()).first<InviteRecord>();if(!invite)return c.json(INVITE_UNAVAILABLE,400);
     if(await isSettledMember(c.env,id,actor.id))return c.json(alreadyMember(parsed.data.operationId,{workspaceId:id}));
     const result=await runAccessChange(c.env,actor,{operationId:parsed.data.operationId,kind:"workspace-invite-accept",payload:{workspaceId:id,inviteId:invite.id,inviteHash:hash},workspaceIds:[id],inheritWorkspaceBoards:true});
     if(result.state!=="completed")return c.json(result,202);
     if(result.outcome==="aborted")return result.result===ACCESS_CHANGE_ABORT.forbidden?c.json({error:"forbidden"} as const,403):c.json(INVITE_UNAVAILABLE,400);
     return c.json(result);
   }catch(e){if(e instanceof AccessChangeConflict)return c.json(ACCESS_CONFLICT,409);throw e;}
  });
