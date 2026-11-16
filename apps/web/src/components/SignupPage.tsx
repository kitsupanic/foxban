import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  newPasswordProblem,
} from "@foxban/shared";
import { api } from "../lib/api";
import { meQuery } from "../lib/auth";
import { AuthShell, Field } from "./AuthShell";
import { buttonVariants } from "./ui/button";
import { Input } from "./ui/input";

export function SignupPage({ invite, workspaceContinuation }: { invite: string | null; workspaceContinuation?: { workspaceId: string; token: string } | null }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const signup = useMutation({
    mutationFn: async () => {
      const response = await api.auth.signup.$post({
        json: { email, password, name, ...(invite ? { invite } : {}) },
      });
      if (!response.ok) {
        const code = response.status === 403 ? ((await response.json().catch(() => null)) as { code?: string } | null)?.code : undefined;
        if (code === "ADMIN_NOT_CONFIGURED") {
          throw new Error("This foxban has no admin yet. Set ADMIN_EMAILS to your email in Cloudflare, then sign up again.");
        }
        // The API answers 403 for a missing, unknown or already-used invite
        // without saying which — the message here stays just as unspecific.
        throw new Error(
            response.status === 409
              ? "That email is already registered."
              : response.status === 403
                ? "This signup needs a valid invite link. Ask an admin for a new one."
                : response.status === 400
                  ? "Choose a less predictable password."
                  : "Could not create the account — check the fields and try again.",
          );
      }
      return await response.json();
    },
    // The `me` query is `staleTime: "static"`, so invalidation alone would not
    // refetch it: seed the new user straight from the response instead.
    onSuccess: async (user) => {
      queryClient.setQueryData(meQuery.queryKey, user);
      if (workspaceContinuation) {
        window.location.assign(`/join-workspace/${encodeURIComponent(workspaceContinuation.workspaceId)}#invite=${workspaceContinuation.token}`);
        return;
      }
      await navigate({ to: "/" });
    },
  });

  return (
    <AuthShell
      title="Create a foxban account"
      submitLabel={signup.isPending ? "Creating…" : "Create account"}
      pending={signup.isPending}
      error={localError ?? signup.error?.message ?? null}
      onSubmit={(event) => {
        event.preventDefault();
        const problem = newPasswordProblem(password);
        if (problem) {
          setLocalError(problem);
          return;
        }
        setLocalError(null);
        signup.mutate();
      }}
      alternative={
        // Only with an invite: without one the API refuses a GitHub signup too. A plain link, like the login page's.
        invite ? (
          <a
            href={`/auth/github/login/start?invite=${encodeURIComponent(invite)}${
              workspaceContinuation ? `&workspaceInvite=${encodeURIComponent(`${workspaceContinuation.workspaceId}.${workspaceContinuation.token}`)}` : ""
            }`}
            className={buttonVariants({ variant: "outline", className: "w-full" })}
          >
            Sign up with GitHub
          </a>
        ) : undefined
      }
      footer={
        <>
          Already registered?{" "}
          <Link
            to="/login"
            hash={workspaceContinuation ? `workspaceInvite=${workspaceContinuation.workspaceId}.${workspaceContinuation.token}` : undefined}
            className={buttonVariants({
              variant: "link",
              className: "h-auto p-0 text-xs font-normal",
            })}
          >
            Sign in
          </Link>
        </>
      }
    >
      {invite ? (
        <p className="text-xs text-muted-foreground">Invite link detected.</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          No invite link detected — ask an admin for one if you need an account.
        </p>
      )}
      {workspaceContinuation && !invite && (
        <p className="text-xs text-muted-foreground">
          This workspace invitation does not grant account access. Obtain a separate Foxban signup invitation, then return here without closing this page.
        </p>
      )}
      <Field label="Email">
        <Input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <Field label="Name">
        <Input
          type="text"
          required
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field
        label="Password"
        hint="Use 8–256 characters; avoid common, repeated, or sequential patterns."
      >
        <Input
          type="password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setLocalError(null);
            setPassword(event.target.value);
          }}
        />
      </Field>
    </AuthShell>
  );
}
