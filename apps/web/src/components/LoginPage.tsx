import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { meQuery } from "../lib/auth";
import { AuthShell, Field } from "./AuthShell";
import { buttonVariants } from "./ui/button";
import { Input } from "./ui/input";

/** Why the GitHub round trip sent the person back here (`?github=`, set by the API's login callback). */
export type GitHubLoginProblem = "error" | "cancelled" | "unlinked" | "exists" | "unavailable";

const GITHUB_LOGIN_MESSAGES: Record<GitHubLoginProblem, string> = {
  error: "GitHub sign-in failed. Try again, or sign in with your email and password.",
  cancelled: "GitHub sign-in was cancelled.",
  // Also what signing up with a missing, unknown or used invite comes to: the reason is not given.
  unlinked:
    "No foxban account is linked to that GitHub account, and signing up needs a valid invite link. Ask an admin for one, or sign in with your email and password and link GitHub in your profile.",
  exists:
    "An email on that GitHub account already has a foxban account. Sign in with your password, then link GitHub in your profile.",
  unavailable: "GitHub sign-in is not set up on this instance.",
};

export function LoginPage({
  workspaceContinuation,
  githubProblem,
}: {
  workspaceContinuation?: { workspaceId: string; token: string } | null;
  githubProblem?: GitHubLoginProblem;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const login = useMutation({
    mutationFn: async () => {
      const response = await api.auth.login.$post({ json: { email, password } });
      if (!response.ok) {
        throw new Error(
          response.status === 401 ? "Incorrect email or password." : "Could not sign in.",
        );
      }
      return await response.json();
    },
    // The `me` query is `staleTime: "static"`, so invalidation alone would not
    // refetch it: seed the signed-in user straight from the response instead.
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
      title="Sign in to foxban"
      submitLabel={login.isPending ? "Signing in…" : "Sign in"}
      pending={login.isPending}
      error={login.error?.message ?? (githubProblem ? GITHUB_LOGIN_MESSAGES[githubProblem] : null)}
      onSubmit={(event) => {
        event.preventDefault();
        login.mutate();
      }}
      alternative={
        // A plain link: the whole round trip through GitHub is full-page navigation, so a pending workspace invitation rides on it.
        <a
          href={
            workspaceContinuation
              ? `/auth/github/login/start?workspaceInvite=${encodeURIComponent(`${workspaceContinuation.workspaceId}.${workspaceContinuation.token}`)}`
              : "/auth/github/login/start"
          }
          className={buttonVariants({ variant: "outline", className: "w-full" })}
        >
          Log in with GitHub
        </a>
      }
      footer={
        <>
          Have an invite?{" "}
          <Link
            to="/signup"
            hash={workspaceContinuation ? `workspaceInvite=${workspaceContinuation.workspaceId}.${workspaceContinuation.token}` : undefined}
            className={buttonVariants({
              variant: "link",
              className: "h-auto p-0 text-xs font-normal",
            })}
          >
            Sign up
          </Link>
        </>
      }
    >
      <Field label="Email">
        <Input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <Field label="Password">
        <Input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
    </AuthShell>
  );
}
