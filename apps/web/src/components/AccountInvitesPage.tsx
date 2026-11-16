import { useEffect, useRef, useState } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, Copy, Link as LinkIcon, Plus } from "lucide-react";
import { api } from "../lib/api";
import { meQuery } from "../lib/auth";
import { AppShell } from "./AppShell";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Invite = { token: string; createdAt: number; usedBy: string | null; usedAt: number | null };
const invitesKey = ["invites"];
const invitesMutationKey = ["invites", "mutation"];
const generateInviteMutationKey = [...invitesMutationKey, "generate"];
const revokeInviteMutationKey = [...invitesMutationKey, "revoke"];
const inviteLink = (token: string) => `${window.location.origin}/signup?invite=${token}`;
const visibleDate = (timestamp: number) => new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" }).format(timestamp);

export function AccountInvitesPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: user } = useQuery(meQuery);
  const [generateSuccess, setGenerateSuccess] = useState<string | null>(null);
  const [revokeSuccess, setRevokeSuccess] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<{ token: string; message: string } | null>(null);
  const invites = useQuery({
    queryKey: invitesKey,
    enabled: user?.isAdmin === true,
    queryFn: async (): Promise<Invite[]> => {
      const response = await api.invites.$get();
      if (!response.ok) throw new Error(`GET /invites failed with ${response.status}`);
      return (await response.json()).invites;
    },
  });
  const generate = useMutation({
    mutationKey: generateInviteMutationKey,
    mutationFn: async () => {
      const response = await api.invites.$post();
      if (!response.ok) throw new Error("Could not generate an invite link.");
      return (await response.json()).token as string;
    },
    onSuccess: async (token) => {
      await queryClient.cancelQueries({ queryKey: invitesKey });
      setGenerateSuccess("Invite link generated.");
      queryClient.setQueryData<Invite[]>(invitesKey, (current) => [
        { token, createdAt: Date.now(), usedBy: null, usedAt: null },
        ...(current ?? []).filter((invite) => invite.token !== token),
      ]);
    },
    onError: () => setGenerateSuccess(null),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: invitesKey });
    },
  });
  const revoke = useMutation({
    mutationKey: revokeInviteMutationKey,
    mutationFn: async (token: string) => {
      const response = await api.invites[":token"].$delete({ param: { token } });
      if (!response.ok && response.status !== 404) throw new Error("Could not revoke that invite.");
      return token;
    },
    onSuccess: () => {
      setRevokeSuccess("Invite revoked.");
      setRevokeError(null);
    },
    onError: (error: Error, token) => {
      setRevokeSuccess(null);
      setRevokeError({ token, message: error.message || "Could not revoke that invite." });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: invitesKey });
    },
  });
  const pending = [...(invites.data?.filter((invite) => !invite.usedBy) ?? [])]
    .sort((left, right) => right.createdAt - left.createdAt);
  const used = [...(invites.data?.filter((invite) => invite.usedBy) ?? [])]
    .sort((left, right) => (right.usedAt ?? -Infinity) - (left.usedAt ?? -Infinity));
  const busy = useIsMutating({ mutationKey: invitesMutationKey }) > 0;
  const actionableRevokeError = revokeError && pending.some((invite) => invite.token === revokeError.token)
    ? revokeError.message
    : null;

  useEffect(() => {
    if (user === null) void navigate({ to: "/login", replace: true });
    else if (user && !user.isAdmin) void navigate({ to: "/", replace: true });
  }, [navigate, user]);
  useEffect(() => {
    if (revokeError && !pending.some((invite) => invite.token === revokeError.token)) setRevokeError(null);
  }, [pending, revokeError]);

  if (!user?.isAdmin) return null;

  return (
    <AppShell breadcrumb="Account invites">
      <div className="boards-heading account-invites-heading">
        <div><h1>Account invites</h1><p>Invite links grant account signup access.</p></div>
        <Button type="button" disabled={busy} onClick={() => { setGenerateSuccess(null); if (generate.error) generate.reset(); generate.mutate(); }}>
          <Plus aria-hidden="true" />{generate.isPending ? "Generating…" : "Generate invite link"}
        </Button>
      </div>
      {generate.error && <p role="alert" className="boards-dialog-error">{generate.error.message}</p>}
      {generateSuccess && <p role="status" className="boards-dialog-success">{generateSuccess}</p>}
      {actionableRevokeError && <p role="alert" className="boards-dialog-error">{actionableRevokeError}</p>}
      {revokeSuccess && <p role="status" className="boards-dialog-success">{revokeSuccess}</p>}
      {invites.isPending && !invites.data ? <p role="status">loading invites…</p> : null}
      {invites.isError && <div className="account-invites-load-error"><p role="alert" className="boards-dialog-error">Could not load invites.</p><Button type="button" variant="outline" size="xs" onClick={() => void invites.refetch()}>Try again</Button></div>}
      {invites.data && (
        <div className="account-invites-layout">
          <section aria-labelledby="active-invites-heading">
            <h2 id="active-invites-heading" className="boards-section-heading">Active links <span>{pending.length}</span></h2>
            {pending.length === 0 ? (
              <div className="account-invites-empty">
                <span className="account-invites-empty-icon"><LinkIcon aria-hidden="true" /></span>
                <div><strong>No active invite links</strong><p>Generate a link when someone needs access.</p></div>
              </div>
            ) : (
              <ul className="account-invites-list">
                {pending.map((invite, index) => (
                  <PendingInvite key={invite.token} invite={invite} ordinal={pending.length - index} disabled={busy} revoking={revoke.isPending && revoke.variables === invite.token} onRevoke={() => { setRevokeSuccess(null); setRevokeError(null); revoke.mutate(invite.token); }} />
                ))}
              </ul>
            )}
          </section>
          <section className="account-invites-rail" aria-labelledby="invite-history-heading">
            <h2 id="invite-history-heading" className="boards-section-heading">Invite history <span>{used.length}</span></h2>
            {used.length === 0 ? <p className="account-invites-history-empty">No used invites yet.</p> : (
              <ol className="account-invites-timeline">{used.map((invite) => <li key={invite.token}><strong>Used</strong><span>{invite.usedAt === null ? "Unknown" : visibleDate(invite.usedAt)}</span></li>)}</ol>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}

function PendingInvite({ invite, ordinal, onRevoke, revoking, disabled }: { invite: Invite; ordinal: number; onRevoke: () => void; revoking: boolean; disabled: boolean }) {
  const [copied, setCopied] = useState(false);
  const [copyCount, setCopyCount] = useState(0);
  const timerRef = useRef<number | null>(null);
  const link = inviteLink(invite.token);
  const shortToken = invite.token.slice(0, 8);
  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current); }, []);
  return (
    <li className="account-invites-card">
      <div className="account-invites-card-top"><strong><LinkIcon aria-hidden="true" />Invite link {ordinal}</strong><span><Check aria-hidden="true" />Ready to share</span></div>
      <div className="account-invites-url-row">
        <Input readOnly aria-label={`Invite link for ${shortToken}`} value={link} onFocus={(event) => event.currentTarget.select()} onClick={(event) => event.currentTarget.select()} className="font-mono text-xs" />
        <Button type="button" variant="outline" size="sm" aria-label={`Copy invite link for ${shortToken}`} onClick={() => { if (!navigator.clipboard?.writeText) return; void navigator.clipboard.writeText(link).then(() => { if (timerRef.current !== null) window.clearTimeout(timerRef.current); setCopied(true); setCopyCount((count) => count + 1); timerRef.current = window.setTimeout(() => { setCopied(false); timerRef.current = null; }, 2000); }).catch(() => undefined); }}><Copy aria-hidden="true" />{copied ? "Copied" : "Copy link"}</Button>
      </div>
      <div className="account-invites-revoke"><Button type="button" variant="ghost" size="xs" disabled={disabled} aria-label={`Revoke invite ${shortToken}`} onClick={onRevoke}>{revoking ? "Revoking…" : "Revoke"}</Button></div>
      {copied && <p key={copyCount} role="status" className="sr-only">Invite link copied to clipboard</p>}
    </li>
  );
}
