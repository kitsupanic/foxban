import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { BookMarked, ExternalLink, GitBranch, Info, Lock, Plus, Trash2, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import { meQuery } from "../lib/auth";
import { AppShell } from "./AppShell";
import { Button, buttonVariants } from "./ui/button";
import { Input } from "./ui/input";

const routeApi = getRouteApi("/account-github");
const gitHubAppKey = ["github-app"];

/** GitHub takes the manifest as a browser form post, so the Admin's browser sends it. */
function postManifestToGitHub(url: string, manifest: unknown) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = url;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = JSON.stringify(manifest);
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}

export function AccountGitHubPage() {
  const navigate = useNavigate();
  const { githubApp } = routeApi.useSearch();
  const { data: user } = useQuery(meQuery);
  const [ownerKind, setOwnerKind] = useState<"me" | "organization">("organization");
  const [organization, setOrganization] = useState("");
  // The Admin's public organizations, as one-click picks. GitHub's public API needs no token;
  // private memberships are not listed, so the field stays for those.
  const organizations = useQuery({
    queryKey: ["github-public-orgs", user?.githubLogin],
    enabled: Boolean(user?.isAdmin && user.githubLogin),
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const response = await fetch(`https://api.github.com/users/${encodeURIComponent(user!.githubLogin!)}/orgs`);
      if (!response.ok) return [];
      return ((await response.json()) as Array<{ login: string }>).map((org) => org.login);
    },
  });
  const status = useQuery({
    queryKey: gitHubAppKey,
    enabled: user?.isAdmin === true,
    // Opening the page, and coming back from GitHub, both re-read the truth.
    refetchOnMount: "always",
    queryFn: async () => {
      const response = await api["github-app"].$get();
      if (!response.ok) throw new Error(`GET /github-app failed with ${response.status}`);
      return response.json();
    },
  });
  const create = useMutation({
    mutationFn: async () => {
      const trimmed = ownerKind === "organization" ? organization.trim() : "";
      if (ownerKind === "organization" && !trimmed) throw new Error("Pick or type the organization that should own the App.");
      const response = await api["github-app"].manifest.$post({ json: trimmed ? { organization: trimmed } : {} });
      if (!response.ok) throw new Error(response.status === 400 ? "That is not a valid GitHub organization name." : "Could not start creating the GitHub App.");
      return response.json();
    },
    onSuccess: ({ url, manifest }) => postManifestToGitHub(url, manifest),
  });

  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const remove = useMutation({
    mutationFn: async () => {
      const response = await api["github-app"].$delete();
      if (!response.ok && response.status !== 404) throw new Error("Could not remove the GitHub App.");
    },
    onSuccess: () => {
      setConfirmingRemove(false);
      // Drop a leftover "GitHub App created." from the URL.
      void navigate({ to: "/account-github", search: {}, replace: true });
      void status.refetch();
    },
  });

  useEffect(() => {
    if (user === null) void navigate({ to: "/login", replace: true });
    else if (user && !user.isAdmin) void navigate({ to: "/", replace: true });
  }, [navigate, user]);

  if (!user?.isAdmin) return null;
  const app = status.data?.app ?? null;

  return (
    <AppShell breadcrumb="GitHub">
      <div className="boards-heading">
        <div><h1>GitHub</h1><p>One GitHub App connects this foxban to your repos.</p></div>
      </div>
      {githubApp === "created" && <p role="status" className="boards-dialog-success">GitHub App created.</p>}
      {githubApp === "error" && <p role="alert" className="boards-dialog-error">GitHub did not finish creating the App. Try again.</p>}
      {status.isPending && <p role="status">Loading GitHub status…</p>}
      {status.isError && <div className="account-invites-load-error"><p role="alert" className="boards-dialog-error">Could not load GitHub status.</p><Button type="button" variant="outline" size="xs" onClick={() => void status.refetch()}>Try again</Button></div>}
      {status.data && app && (
        <>
          <section aria-labelledby="github-app-heading" className="github-app-panel">
            <div className="github-app-status">
              <span className="github-app-mark" aria-hidden="true"><GitBranch /></span>
              <div className="github-app-identity">
                <h2 id="github-app-heading">{app.owner ? `Connected to ${app.owner}` : "GitHub is connected"} <span className="github-app-on">On</span></h2>
                <p>GitHub App <code>{app.slug}</code></p>
              </div>
              <div className="github-app-actions">
                {app.settingsUrl && <a className={buttonVariants({ variant: "outline" })} href={app.settingsUrl}><ExternalLink aria-hidden="true" />App settings</a>}
                <a className={buttonVariants()} href={app.installUrl}><Plus aria-hidden="true" />Add repos</a>
              </div>
            </div>
            <h3 className="github-app-section-title"><BookMarked aria-hidden="true" />Connected repos <span>{app.repos.length}</span></h3>
            {app.repos.length === 0 ? <p className="github-app-note">No repos are connected yet. Click Add repos and pick them on GitHub.</p> : (
              <ul aria-label="Connected repos" className="github-app-repos">
                {app.repos.map((repo) => {
                  const slash = repo.fullName.indexOf("/") + 1;
                  return (
                    <li key={repo.id}>
                      <BookMarked aria-hidden="true" />
                      <span className="github-app-repo-name"><span>{repo.fullName.slice(0, slash)}</span><strong>{repo.fullName.slice(slash)}</strong></span>
                      {repo.private && <span className="github-app-badge"><Lock aria-hidden="true" />Private</span>}
                      <a className={buttonVariants({ variant: "ghost", size: "icon-sm" })} href={`https://github.com/${repo.fullName}`} target="_blank" rel="noreferrer" aria-label={`Open ${repo.fullName} on GitHub`}><ExternalLink aria-hidden="true" /></a>
                    </li>
                  );
                })}
              </ul>
            )}
            {!app.reposRefreshed && <p role="status" className="github-app-note">Could not reach GitHub just now, so this list may be out of date.</p>}
            {app.owner && <p className="github-app-note"><Info aria-hidden="true" /><span>Only repos owned by <strong>{app.owner}</strong> are used.</span></p>}
          </section>
          {app.owner && app.settingsUrl && app.ignoredAccounts.length > 0 && (
            <div role="alert" className="github-app-warning">
              <TriangleAlert aria-hidden="true" />
              <div>
                <strong>Also installed on {app.ignoredAccounts.join(", ")}, but skipped</strong>
                <p>foxban only uses repos that {app.owner} owns. To use the others, move the App to that account:</p>
                <ol><li>Open the App's settings on GitHub.</li><li>Go to Advanced, then Transfer ownership.</li><li>Come back to this page.</li></ol>
                <a className={buttonVariants({ variant: "outline", size: "sm" })} href={app.settingsUrl}><ExternalLink aria-hidden="true" />Open App settings on GitHub</a>
              </div>
            </div>
          )}
          <section aria-labelledby="github-remove-heading" className="github-app-danger">
            {confirmingRemove ? (
              <div role="alert">
                <h3 id="github-remove-heading">Remove the GitHub App from foxban?</h3>
                <ul>
                  <li>GitHub features turn off until you create a new App.</li>
                  <li>Cards keep the branches and PRs they already show.</li>
                  <li>GitHub keeps the App. To delete it there too, use Delete GitHub App in {app.settingsUrl ? <a href={app.settingsUrl} target="_blank" rel="noreferrer">the App's settings on GitHub<ExternalLink aria-hidden="true" /></a> : "the App's settings on GitHub"}.</li>
                </ul>
                <div className="github-app-actions">
                  <Button type="button" variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}><Trash2 aria-hidden="true" />{remove.isPending ? "Removing…" : "Yes, remove it"}</Button>
                  <Button type="button" variant="outline" disabled={remove.isPending} onClick={() => setConfirmingRemove(false)}>Cancel</Button>
                </div>
                {remove.error && <p role="alert" className="boards-dialog-error">{remove.error.message}</p>}
              </div>
            ) : (
              <div className="github-app-danger-row">
                <div>
                  <h3 id="github-remove-heading">Remove the App</h3>
                  <p>Turns off GitHub features in foxban. Use it to start over, for example under another owner.</p>
                </div>
                <Button type="button" variant="outline" className="github-app-remove" onClick={() => setConfirmingRemove(true)}><Trash2 aria-hidden="true" />Remove GitHub App</Button>
              </div>
            )}
          </section>
        </>
      )}
      {status.data && !app && (
        <section aria-labelledby="github-off-heading" className="account-invites-empty">
          <div>
            <h2 id="github-off-heading" className="boards-section-heading">GitHub features are off</h2>
            <p>This instance has no GitHub App yet. Create one to turn them on: GitHub opens, you confirm, and you come back here. Then install the App on your repos.</p>
            {status.data.canCreate ? (
              <>
                <fieldset>
                  <legend>Who should own the App?</legend>
                  <p>Pick the account that owns the repos you want to connect. foxban only uses repos from the App's owner.</p>
                  <label><input type="radio" name="github-app-owner" checked={ownerKind === "organization"} onChange={() => setOwnerKind("organization")} /> An organization</label>
                  {ownerKind === "organization" && (
                    <div>
                      {organizations.data && organizations.data.length > 0 && (
                        <p>
                          {organizations.data.map((login) => (
                            <Button key={login} type="button" size="xs" variant={organization === login ? "default" : "outline"} aria-pressed={organization === login} onClick={() => setOrganization(login)}>{login}</Button>
                          ))}
                        </p>
                      )}
                      <label>Organization name<Input value={organization} onChange={(event) => setOrganization(event.target.value)} placeholder="my-organization" autoComplete="off" /></label>
                      <p>It is the name in the organization's GitHub address: github.com/<strong>{organization.trim() || "name"}</strong>. <a href="https://github.com/settings/organizations" target="_blank" rel="noreferrer">See your organizations on GitHub</a>.</p>
                    </div>
                  )}
                  <label><input type="radio" name="github-app-owner" checked={ownerKind === "me"} onChange={() => setOwnerKind("me")} /> My own GitHub account{user.githubLogin ? ` (${user.githubLogin})` : ""}</label>
                </fieldset>
                <Button type="button" disabled={create.isPending} onClick={() => create.mutate()}><GitBranch aria-hidden="true" />{create.isPending ? "Opening GitHub…" : "Create GitHub App"}</Button>
                {create.error && <p role="alert" className="boards-dialog-error">{create.error.message}</p>}
              </>
            ) : (
              <p role="alert" className="boards-dialog-error">This instance has no GITHUB_APP_ENCRYPTION_KEY secret yet. Run <code>pnpm run deploy</code> to create it, or set it yourself to the output of <code>openssl rand -base64 32</code>.</p>
            )}
          </div>
        </section>
      )}
    </AppShell>
  );
}
