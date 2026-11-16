import { useEffect } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { meQuery } from "../lib/auth";
import { allWorkspacesQuery } from "../lib/workspaces";
import { AppShell } from "./AppShell";
import { Button, buttonVariants } from "./ui/button";

/** `/all-workspaces`: Admin only. Every workspace in the instance, each linking to its own page. */
export function AllWorkspacesPage() {
  const navigate = useNavigate();
  const { data: user } = useQuery(meQuery);
  const workspaces = useQuery({ ...allWorkspacesQuery, enabled: user?.isAdmin === true });

  useEffect(() => {
    if (user === null) void navigate({ to: "/login", replace: true });
    else if (user && !user.isAdmin) void navigate({ to: "/", replace: true });
  }, [navigate, user]);

  if (!user?.isAdmin) return null;

  return (
    <AppShell breadcrumb="All workspaces">
      <div className="boards-heading"><div><h1>All workspaces</h1><p>Every workspace in this instance. Opening one you are not a member of is Operator access.</p></div></div>
      {workspaces.isError ? (
        <div className="boards-list-state"><p role="alert">Could not load workspaces.</p><Button type="button" variant="outline" size="xs" onClick={() => void workspaces.refetch()}>Try again</Button></div>
      ) : workspaces.isPending ? (
        <p role="status" className="boards-list-state">loading workspaces…</p>
      ) : (
        <>
          <div className="boards-section-heading"><strong>Workspaces</strong><span>{workspaces.data.length}</span></div>
          <ul className="boards-list" aria-label="All workspaces">
            {workspaces.data.map((workspace) => (
              <li key={workspace.id} className="boards-row">
                <span className="workspace-initials" aria-hidden="true">{workspace.name.slice(0, 2).toUpperCase()}</span>
                <div className="boards-board-identity">
                  <Link to="/w/$workspaceId" params={{ workspaceId: workspace.id }} className={buttonVariants({ variant: "link", className: "boards-board-name" })}>{workspace.name}</Link>
                  <span>{workspace.createdBy && <>Created by {workspace.createdBy} · </>}{workspace.boardCount} {workspace.boardCount === 1 ? "board" : "boards"} <b className="board-access-label">{workspace.access === "member" ? "Member" : "Operator"}</b></span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </AppShell>
  );
}
