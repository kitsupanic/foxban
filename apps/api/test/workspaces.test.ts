import { SELF, applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const ORIGIN="https://foxban.test",PASSWORD="correct horse battery";
const cookie=(response:Response)=>response.headers.get("set-cookie")!.split(";")[0]!;
const request=(path:string,method:string,body?:unknown,session?:string)=>SELF.fetch(ORIGIN+path,{method,headers:{...(body===undefined?{}:{"content-type":"application/json"}),...(session?{cookie:session}:{})},body:body===undefined?undefined:JSON.stringify(body)});
async function signup(email:string,invite?:string){const response=await request("/auth/signup","POST",{email,name:email.split("@")[0],password:PASSWORD,...(invite?{invite}:{})});expect(response.status).toBe(200);return cookie(response);}

beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});

describe("shared workspaces",()=>{
  it("creates, shares, invites, and moves without widening restricted access",async()=>{
    const admin=await signup(`admin-workspaces-${crypto.randomUUID()}@foxban.test`);
    const accountInviteResponse=await request("/invites","POST",{},admin);
    const accountInvite=(await accountInviteResponse.json<{token:string}>()).token;
    const member=await signup(`member-${crypto.randomUUID()}@example.test`,accountInvite);

    const created=await request("/workspaces","POST",{name:"  Product  "},admin);
    expect(created.status).toBe(201);
    const workspace=(await created.json<{workspace:{id:string;name:string;role:string;boardCount:number}}>()).workspace;
    expect(workspace).toMatchObject({name:"Product",role:"admin",boardCount:0});
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND role='admin'").bind(workspace.id).first<{n:number}>())?.n).toBe(1);

    expect((await request("/workspaces","POST",{name:" ".repeat(2)},admin)).status).toBe(400);
    expect((await request("/workspaces","POST",{name:"x".repeat(41)},admin)).status).toBe(400);

    const inviteResponse=await request(`/workspaces/${workspace.id}/invites`,"POST",{role:"member"},admin);
    expect(inviteResponse.status).toBe(201);
    const invitation=await inviteResponse.json<{invite:{id:string;expiresAt:number;createdAt:number};token:string}>();
    expect(invitation.invite.expiresAt-invitation.invite.createdAt).toBe(7*86_400_000);
    const persisted=await env.DB.prepare("SELECT token_hash AS hash FROM workspace_invites WHERE id=?").bind(invitation.invite.id).first<{hash:string}>();
    expect(persisted?.hash).not.toBe(invitation.token);

    const accepted=await request(`/workspaces/${workspace.id}/invites/accept`,"POST",{token:invitation.token,operationId:crypto.randomUUID()},member);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({state:"completed",outcome:"committed",result:{workspaceId:workspace.id}});

    const boardResponse=await request("/boards","POST",{name:"Shared",key:`W${crypto.randomUUID().replaceAll("-","").slice(0,8).toUpperCase()}`,workspaceId:workspace.id,accessMode:"workspace"},admin);
    expect(boardResponse.status).toBe(200);
    const board=await boardResponse.json<{id:string;workspaceId:string;accessMode:string;capabilities:{canManageBoard:boolean}}>();
    expect(board).toMatchObject({workspaceId:workspace.id,accessMode:"workspace",capabilities:{canManageBoard:true}});
    expect((await request(`/boards/${board.id}`,"GET",undefined,member)).status).toBe(200);

    const destinationResponse=await request("/workspaces","POST",{name:"Archive"},admin);
    const destination=(await destinationResponse.json<{workspace:{id:string}}>()).workspace;
    const moved=await request(`/boards/${board.id}/move-workspace`,"POST",{destinationWorkspaceId:destination.id,expectedWorkspaceId:workspace.id,expectedAccessVersion:0,operationId:crypto.randomUUID()},admin);
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({state:"completed",outcome:"committed",result:{boardId:board.id,workspaceId:destination.id,accessMode:"restricted"}});
    expect((await request(`/boards/${board.id}`,"GET",undefined,member)).status).toBe(403);
    const metadata=await request(`/boards/${board.id}`,"GET",undefined,admin);
    expect(await metadata.json()).toMatchObject({id:board.id,workspaceId:destination.id,accessMode:"restricted",accessVersion:1});
  });

  it("keeps a workspace discoverable for a member whose only boards are hidden",async()=>{
    const admin=await signup(`admin-discovery-${crypto.randomUUID()}@foxban.test`);
    const accountInvite=(await(await request("/invites","POST",{},admin)).json<{token:string}>()).token;
    const member=await signup(`member-discovery-${crypto.randomUUID()}@example.test`,accountInvite);

    const workspace=(await(await request("/workspaces","POST",{name:"Hidden"},admin)).json<{workspace:{id:string}}>()).workspace;
    // One restricted board the member is deliberately not invited to: they have
    // zero visible boards while the workspace itself still exists for them.
    const hidden=await request("/boards","POST",{name:"Private",key:`H${crypto.randomUUID().replaceAll("-","").slice(0,8).toUpperCase()}`,workspaceId:workspace.id,accessMode:"restricted"},admin);
    expect(hidden.status).toBe(200);
    const hiddenBoard=await hidden.json<{id:string}>();

    const invite=(await(await request(`/workspaces/${workspace.id}/invites`,"POST",{role:"member"},admin)).json<{token:string}>()).token;
    expect((await request(`/workspaces/${workspace.id}/invites/accept`,"POST",{token:invite,operationId:crypto.randomUUID()},member)).status).toBe(200);

    const listResponse=await request("/workspaces","GET",undefined,member);
    expect(listResponse.status).toBe(200);
    const listed=(await listResponse.json<{workspaces:Array<{id:string;role:string|null;access:string;boardCount:number}>}>()).workspaces;
    const entry=listed.find((item)=>item.id===workspace.id);
    expect(entry).toMatchObject({role:"member",access:"member",boardCount:0});
    // The board they cannot open is neither listed nor counted, and stays unreadable.
    expect((await request(`/boards/${hiddenBoard.id}`,"GET",undefined,member)).status).toBe(403);
    expect(await (await request(`/boards?workspaceId=${workspace.id}`,"GET",undefined,member)).json()).toEqual([]);
    // A member with zero visible boards can still create one in the workspace.
    const created=await request("/boards","POST",{name:"Mine",key:`M${crypto.randomUUID().replaceAll("-","").slice(0,8).toUpperCase()}`,workspaceId:workspace.id,accessMode:"workspace"},member);
    expect(created.status).toBe(200);
  });

  it("reports persisted settings and invitations only for the manager who really wrote them",async()=>{
    const admin=await signup(`admin-settings-${crypto.randomUUID()}@foxban.test`);
    const accountInvite=(await(await request("/invites","POST",{},admin)).json<{token:string}>()).token;
    const member=await signup(`member-settings-${crypto.randomUUID()}@example.test`,accountInvite);

    const workspace=(await(await request("/workspaces","POST",{name:"Settings"},admin)).json<{workspace:{id:string}}>()).workspace;
    const invite=(await(await request(`/workspaces/${workspace.id}/invites`,"POST",{role:"member"},admin)).json<{token:string}>()).token;
    expect((await request(`/workspaces/${workspace.id}/invites/accept`,"POST",{token:invite,operationId:crypto.randomUUID()},member)).status).toBe(200);

    // A member cannot rename the workspace, and the write is refused rather than
    // reported as applied.
    const refused=await request(`/workspaces/${workspace.id}`,"PATCH",{name:"Renamed by member"},member);
    expect(refused.status).toBe(403);
    expect(await env.DB.prepare("SELECT name FROM workspaces WHERE id=?").bind(workspace.id).first()).toEqual({name:"Settings"});

    // The manager's answer is the row that landed, with a real board count.
    const renamed=await request(`/workspaces/${workspace.id}`,"PATCH",{name:"Renamed"},admin);
    expect(renamed.status).toBe(200);
    await request("/boards","POST",{name:"Shared",key:`S${crypto.randomUUID().replaceAll("-","").slice(0,8).toUpperCase()}`,workspaceId:workspace.id,accessMode:"workspace"},admin);
    const read=await request(`/workspaces/${workspace.id}`,"PATCH",{defaultBoardAccess:"restricted"},admin);
    expect(read.status).toBe(200);
    expect(await read.json<{workspace:Record<string,unknown>}>()).toMatchObject({workspace:{id:workspace.id,name:"Renamed",defaultBoardAccess:"restricted",role:"admin",boardCount:1}});
    expect(await env.DB.prepare("SELECT name,default_board_access AS access FROM workspaces WHERE id=?").bind(workspace.id).first()).toEqual({name:"Renamed",access:"restricted"});

    // An invitation is only returned with the row that is actually there. Holding
    // the workspace scope refuses issuance and revocation instead of pretending.
    const invited=await request(`/workspaces/${workspace.id}/invites`,"POST",{role:"member"},admin);
    expect(invited.status).toBe(201);
    const issued=await invited.json<{invite:{id:string};token:string}>();
    await env.DB.prepare("INSERT INTO access_change_scopes(workspace_id,operation_id) VALUES(?,?)").bind(workspace.id,"held-scope").run();
    const lockedIssue=await request(`/workspaces/${workspace.id}/invites`,"POST",{role:"member"},admin);
    expect(lockedIssue.status).toBe(409);
    expect(await lockedIssue.json()).toMatchObject({code:"access_change_conflict"});
    const lockedRevoke=await request(`/workspaces/${workspace.id}/invites/${issued.invite.id}`,"DELETE",undefined,admin);
    expect(lockedRevoke.status).toBe(409);
    expect(await env.DB.prepare("SELECT revoked_at AS revokedAt FROM workspace_invites WHERE id=?").bind(issued.invite.id).first()).toEqual({revokedAt:null});
    await env.DB.prepare("DELETE FROM access_change_scopes WHERE operation_id=?").bind("held-scope").run();

    const revoked=await request(`/workspaces/${workspace.id}/invites/${issued.invite.id}`,"DELETE",undefined,admin);
    expect(revoked.status).toBe(200);
    // Revoking what is already revoked is the outcome the caller asked for, and a
    // child that does not exist is a real miss.
    expect((await request(`/workspaces/${workspace.id}/invites/${issued.invite.id}`,"DELETE",undefined,admin)).status).toBe(200);
    expect((await request(`/workspaces/${workspace.id}/invites/${crypto.randomUUID()}`,"DELETE",undefined,admin)).status).toBe(404);
    expect((await request(`/workspaces/${workspace.id}/invites/${issued.invite.id}`,"DELETE",undefined,member)).status).toBe(403);
  });

  it("counts a workspace detail with the same authorization-bearing read that answers it",async()=>{
    const admin=await signup(`admin-detail-${crypto.randomUUID()}@foxban.test`);
    const memberInvite=await request("/invites","POST",{},admin);
    const member=await signup(`member-${crypto.randomUUID()}@example.test`,(await memberInvite.json<{token:string}>()).token);

    const created=await request("/workspaces","POST",{name:"Detail"},admin);
    const workspace=(await created.json<{workspace:{id:string}}>()).workspace;
    const invitation=await request(`/workspaces/${workspace.id}/invites`,"POST",{role:"member"},admin);
    const {token}=await invitation.json<{token:string}>();
    expect((await request(`/workspaces/${workspace.id}/invites/accept`,"POST",{token,operationId:crypto.randomUUID()},member)).status).toBe(200);
    // A Restricted board the member holds no grant on: a member may still create boards
    // here, so the workspace stays discoverable with a count of zero.
    const boardResponse=await request("/boards","POST",{name:"Hidden",key:`D${crypto.randomUUID().replaceAll("-","").slice(0,8).toUpperCase()}`,workspaceId:workspace.id,accessMode:"restricted"},admin);
    expect(boardResponse.status).toBe(200);
    const board=await boardResponse.json<{id:string}>();
    const memberId=(await (await request("/me","GET",undefined,member)).json<{id:string}>()).id;

    const listed=(await (await request("/workspaces","GET",undefined,member)).json<{workspaces:Array<{id:string;role:string|null;access:string;boardCount:number}>}>()).workspaces.find((entry)=>entry.id===workspace.id);
    expect(listed).toMatchObject({role:"member",access:"member",boardCount:0});
    // The detail read authorizes itself: it must not reuse a role captured earlier to
    // count boards the viewer cannot discover, or it would report a board it denies.
    const detail=await request(`/workspaces/${workspace.id}`,"GET",undefined,member);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({workspace:{id:workspace.id,role:"member",access:"member",boardCount:0}});

    // An explicit grant is what makes the board discoverable, in both reads.
    expect((await request(`/boards/${board.id}/members`,"POST",{userId:memberId},admin)).status).toBe(200);
    expect((await (await request("/workspaces","GET",undefined,member)).json<{workspaces:Array<{id:string;boardCount:number}>}>()).workspaces.find((entry)=>entry.id===workspace.id)?.boardCount).toBe(1);
    expect(await (await request(`/workspaces/${workspace.id}`,"GET",undefined,member)).json()).toMatchObject({workspace:{boardCount:1}});
  });

  it("refuses a workspace detail whose membership is removed while the request is in flight",async()=>{
    const admin=await signup(`admin-detail-race-${crypto.randomUUID()}@foxban.test`);
    const memberInvite=await request("/invites","POST",{},admin);
    const member=await signup(`member-${crypto.randomUUID()}@example.test`,(await memberInvite.json<{token:string}>()).token);
    const memberId=(await (await request("/me","GET",undefined,member)).json<{id:string}>()).id;

    const created=await request("/workspaces","POST",{name:"Detail race"},admin);
    const workspace=(await created.json<{workspace:{id:string}}>()).workspace;
    const invitation=await request(`/workspaces/${workspace.id}/invites`,"POST",{role:"member"},admin);
    const {token}=await invitation.json<{token:string}>();
    expect((await request(`/workspaces/${workspace.id}/invites/accept`,"POST",{token,operationId:crypto.randomUUID()},member)).status).toBe(200);
    const boardResponse=await request("/boards","POST",{name:"Shared",key:`R${crypto.randomUUID().replaceAll("-","").slice(0,8).toUpperCase()}`,workspaceId:workspace.id,accessMode:"workspace"},admin);
    expect(boardResponse.status).toBe(200);

    // The membership is removed while this request is still producing its answer: the
    // role the request started with must not authorize the view, nor widen the count
    // it reports, so the detail read re-derives both at the moment it answers.
    const originalPrepare=env.DB.prepare.bind(env.DB);
    let armed=true;
    // @ts-expect-error test stubbing
    env.DB.prepare=(query:string)=>{
      const stmt=originalPrepare(query);
      if(!armed||!(query.includes("COUNT(*) AS n FROM boards b LEFT JOIN board_members bm")||query.includes("COUNT(DISTINCT b.id) AS boardCount")))return stmt;
      return {
        ...stmt,
        bind(...params:unknown[]){
          const bound=stmt.bind(...params);
          const readView=bound.first.bind(bound) as () => Promise<unknown>;
          return {
            ...bound,
            async first(){
              if(armed){
                armed=false;
                await originalPrepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(workspace.id,memberId).run();
              }
              return readView();
            },
          };
        },
      };
    };
    try{
      const detail=await request(`/workspaces/${workspace.id}`,"GET",undefined,member);
      expect(detail.status).toBe(403);
      expect(await detail.json()).toEqual({error:"forbidden"});
    }finally{
      env.DB.prepare=originalPrepare;
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND user_id=?").bind(workspace.id,memberId).first<{n:number}>()).toEqual({n:0});
    // The membership is really gone: a fresh read is a denial, not a member view.
    expect((await request(`/workspaces/${workspace.id}`,"GET",undefined,member)).status).toBe(403);
  });
});

describe("the first workspace",()=>{
  it("is named after the new account and is an ordinary workspace",async()=>{
    const session=await signup(`ada-${crypto.randomUUID()}@foxban.test`);
    const workspaces=(await (await request("/workspaces","GET",undefined,session)).json<{workspaces:{id:string;name:string;role:string;access:string}[]}>()).workspaces.filter((workspace)=>workspace.access==="member");
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({name:expect.stringMatching(/^ada-[0-9a-f-]+'s workspace$/),role:"admin"});
    const renamed=await request(`/workspaces/${workspaces[0]!.id}`,"PATCH",{name:"Renamed"},session);
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({workspace:{name:"Renamed"}});
    expect((await request(`/workspaces/${workspaces[0]!.id}/invites`,"POST",{role:"member"},session)).status).toBe(201);
  });

  it("is not a fallback: creating a board without a workspace is a 400",async()=>{
    const session=await signup(`nofallback-${crypto.randomUUID()}@foxban.test`);
    expect((await request("/boards","POST",{name:"Orphan",key:"ORPH"},session)).status).toBe(400);
  });
});
