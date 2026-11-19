import { useEffect, useId, useRef, useState, type ReactNode, type SubmitEvent } from "react";
import { createPortal } from "react-dom";
import { getRouteApi } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  newPasswordProblem,
} from "@foxban/shared";
import { Check, ChevronDown, GitBranch, Upload, X } from "lucide-react";
import { api } from "../lib/api";
import { meQuery, type User } from "../lib/auth";
import { AppShell } from "./AppShell";
import { Avatar } from "./Avatar";
import { Field } from "./AuthShell";
import { compressImage } from "../lib/compress-image";
import { restoreFocusSoon } from "../lib/focus";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
const profileRouteApi = getRouteApi("/profile");

/**
 * Account settings, rendered as the Profile page in the app shell.
 * Each section keeps its own mutation, drafts, errors and focus; the four
 * visual groups only arrange them.
 */
export function ProfilePage() {
  const { data: user } = useQuery(meQuery);
  const { github } = profileRouteApi.useSearch();
  const [emailOpen, setEmailOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);

  return (
    <AppShell breadcrumb="Profile" overlayOpen={emailOpen || passwordOpen || githubOpen}>
      <div className="boards-heading">
        <div>
          <h1>Profile</h1>
          <p>Manage your details, sign-in settings, and connected accounts.</p>
        </div>
      </div>
      {/* Mid-transition there is nothing real to show; never fake a user. */}
      {user && (
            <div className="profile-layout">
              <nav className="profile-index" aria-label="Profile sections">
                <a href="#profile-personal">Personal details</a>
                <a href="#profile-preferences">Preferences</a>
                <a href="#profile-security">Sign-in &amp; security</a>
                <a href="#profile-accounts">Connected accounts</a>
              </nav>
              <div className="profile-panels">
                <section id="profile-personal" className="profile-panel">
                  <h2>Personal details</h2>
                  <p>Your name and avatar across Foxban.</p>
                  <div className="profile-section-body">
                    <AvatarSection user={user} />
                    <DisplayNameSection user={user} />
                  </div>
                </section>
                <section id="profile-preferences" className="profile-panel">
                  <h2>Preferences</h2>
                  <p>Choose your local timezone.</p>
                  <div className="profile-section-body">
                    <TimezoneSection user={user} />
                  </div>
                </section>
                <section id="profile-security" className="profile-panel">
                  <h2>Sign-in &amp; security</h2>
                  <p>Manage how you access your account.</p>
                  <div className="profile-section-body">
                    <EmailSection user={user} open={emailOpen} onOpenChange={setEmailOpen} />
                    <PasswordSection user={user} githubReturn={github} open={passwordOpen} onOpenChange={setPasswordOpen} />
                  </div>
                </section>
                <section id="profile-accounts" className="profile-panel">
                  <h2>Connected accounts</h2>
                  <p>Manage your GitHub connection.</p>
                  <div className="profile-section-body">
                    <GitHubSection user={user} githubError={github === "error" || github === "taken" ? github : undefined} open={githubOpen} onOpenChange={setGithubOpen} />
                  </div>
                </section>
              </div>
            </div>
      )}
    </AppShell>
  );
}

function AvatarSection({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadAvatar = useMutation({
    mutationFn: async (file: File) => {
      const prepared = await compressImage(file, { maxEdge: 512, quality: 0.8, forceWebp: true });
      const response = await fetch("/me/avatar", {
        method: "POST",
        headers: {
          "Content-Type": prepared.contentType,
        },
        body: prepared.blob,
      });
      if (!response.ok) {
        if (response.status === 413) {
          throw new Error("File exceeds maximum size of 10 MB.");
        }
        if (response.status === 415) {
          throw new Error("Unsupported image format. Use PNG, JPEG, GIF, or WebP.");
        }
        throw new Error("Could not upload avatar. Try again.");
      }
      return (await response.json()) as User;
    },
    onSuccess: (updatedUser) => {
      queryClient.setQueryData(meQuery.queryKey, updatedUser);
      void queryClient.invalidateQueries({ queryKey: ["board-members"] });
      setSuccess("Avatar updated.");
      setError(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (err: Error) => {
      setError(err.message);
      setSuccess(null);
    },
  });

  const removeAvatar = useMutation({
    mutationFn: async () => {
      const response = await fetch("/me/avatar", {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("Could not remove avatar. Try again.");
      }
      return (await response.json()) as User;
    },
    onSuccess: (updatedUser) => {
      queryClient.setQueryData(meQuery.queryKey, updatedUser);
      void queryClient.invalidateQueries({ queryKey: ["board-members"] });
      setSuccess("Avatar removed.");
      setError(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (err: Error) => {
      setError(err.message);
      setSuccess(null);
    },
  });

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    setSuccess(null);
    uploadAvatar.mutate(file);
  };

  const pending = uploadAvatar.isPending || removeAvatar.isPending;
  const avatarSource = user.avatarVersion
    ? "Custom uploaded avatar"
    : user.githubLogin
      ? "Using your GitHub avatar"
      : "Initials avatar";

  return (
    <div className="profile-field profile-avatar">
      <div className="profile-avatar-row">
        <div className="profile-avatar-preview">
          <Avatar
            name={user.name}
            githubLogin={user.githubLogin}
            avatarVersion={user.avatarVersion}
            userId={user.id}
          />
        </div>
        <div className="profile-avatar-details">
          <div className="profile-avatar-actions">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={handleFileChange}
              className="sr-only"
              id="avatar-upload-input"
              disabled={pending}
            />
            <Button
              type="button"
              variant="outline"
              className="profile-action"
              disabled={pending}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload aria-hidden="true" />
              {uploadAvatar.isPending ? "Uploading…" : "Upload avatar"}
            </Button>
            {user.avatarVersion && (
              <Button
                type="button"
                variant="ghost"
                className="profile-action text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={pending}
                onClick={() => {
                  setError(null);
                  setSuccess(null);
                  removeAvatar.mutate();
                }}
              >
                {removeAvatar.isPending ? "Removing…" : "Remove"}
              </Button>
            )}
          </div>
          <p className="profile-hint">{avatarSource}</p>
        </div>
      </div>
      {error && <p role="alert" className="profile-status profile-status-error">{error}</p>}
      {success && <p role="status" className="profile-status profile-status-success">{success}</p>}
    </div>
  );
}

function DisplayNameSection({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(user.name);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const updateName = useMutation({
    mutationFn: async () => {
      const response = await api.me.$patch({ json: { name } });
      if (!response.ok) {
        throw new Error("Could not update your name.");
      }
      return (await response.json()) as User;
    },
    onSuccess: (updatedUser) => {
      queryClient.setQueryData(meQuery.queryKey, updatedUser);
      setName(updatedUser.name);
      void queryClient.invalidateQueries({ queryKey: ["board-members"] });
      setSuccess("Name updated.");
      setError(null);
    },
    onError: (err: Error) => {
      setError(err.message);
      setSuccess(null);
    },
  });

  return (
    <form
      className="profile-field profile-name"
      onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError(null);
        setSuccess(null);
        updateName.mutate();
      }}
    >
      <Field label="Display name">
        <Input
          type="text"
          required
          autoComplete="name"
          className="profile-control"
          value={name}
          disabled={updateName.isPending}
          onChange={(event) => {
            setError(null);
            setSuccess(null);
            setName(event.target.value);
          }}
        />
      </Field>
      {error && <p role="alert" className="profile-status profile-status-error">{error}</p>}
      {success && <p role="status" className="profile-status profile-status-success">{success}</p>}
      <div className="profile-actions-end">
        <Button
          type="submit"
          className="profile-action"
          disabled={updateName.isPending || name === user.name}
        >
          {updateName.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

interface ProfileCredentialDialogProps {
  title: string;
  description: string;
  formLabel: string;
  formId: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  children: ReactNode;
}

function ProfileCredentialDialog({
  title,
  description,
  formLabel,
  formId,
  busy,
  onClose,
  onSubmit,
  children,
}: ProfileCredentialDialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (busy) return;
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const nodes = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => node.offsetParent !== null);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (
        event.shiftKey &&
        (document.activeElement === first || !panelRef.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !panelRef.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  return createPortal(
    <div
      className="boards-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="boards-dialog-panel profile-credential-dialog"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close dialog"
          disabled={busy}
          className="boards-dialog-close"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
        <h2 id={titleId}>{title}</h2>
        <p>{description}</p>
        <form id={formId} aria-label={formLabel} className="profile-editor" onSubmit={onSubmit}>
          {children}
        </form>
      </div>
    </div>,
    document.body,
  );
}

function EmailSection({
  user,
  open,
  onOpenChange,
}: {
  user: User;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState(user.email);
  const [currentPassword, setCurrentPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const editorId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  const updateEmail = useMutation({
    mutationFn: async () => {
      const response = await api.auth.email.$post({ json: { email, currentPassword } });
      if (!response.ok) {
        if (response.status === 401) throw new Error("Current password is incorrect.");
        if (response.status === 403) {
          throw new Error("Email changes cannot alter administrator access.");
        }
        if (response.status === 409) throw new Error("That email is already registered.");
        if (response.status === 429) throw new Error("Too many attempts. Try again later.");
        throw new Error("Could not update your email.");
      }
      return (await response.json()) as User;
    },
    onSuccess: (updatedUser) => {
      queryClient.setQueryData(meQuery.queryKey, updatedUser);
      setEmail(updatedUser.email);
      setCurrentPassword("");
      void queryClient.invalidateQueries({ queryKey: ["board-members"] });
      setSuccess("Email updated.");
      setError(null);
      onOpenChange(false);
      restoreFocusSoon(triggerRef.current);
    },
    onError: (err: Error) => {
      setError(err.message);
      setSuccess(null);
    },
  });

  useEffect(() => {
    if (open) firstInputRef.current?.focus();
  }, [open]);

  const openEditor = () => {
    setEmail(user.email);
    setCurrentPassword("");
    setError(null);
    onOpenChange(true);
  };
  const closeEditor = () => {
    if (updateEmail.isPending) return;
    setEmail(user.email);
    setCurrentPassword("");
    setError(null);
    onOpenChange(false);
    restoreFocusSoon(triggerRef.current);
  };

  return (
    <div className="profile-field profile-credential">
      <div className="profile-row">
        <div className="profile-row-identity">
          <strong>Sign-in email</strong>
          <span>{user.email}</span>
        </div>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          className="profile-action"
          aria-expanded={open}
          aria-controls={editorId}
          hidden={open}
          disabled={!user.hasPassword}
          onClick={openEditor}
        >
          Change email
        </Button>
      </div>
      {!user.hasPassword && <p className="profile-hint">Set a password to change your sign-in email.</p>}
      {open && (
        <ProfileCredentialDialog
          title="Change sign-in email"
          formLabel="Change email"
          description="Enter your new email and current password."
          formId={editorId}
          busy={updateEmail.isPending}
          onClose={closeEditor}
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setSuccess(null);
            updateEmail.mutate();
          }}
        >
          <div className="profile-current-email">
            <span>Current email</span>
            <strong>{user.email}</strong>
          </div>
          <Field label="New email">
            <Input
              ref={firstInputRef}
              type="email"
              required
              autoComplete="email"
              className="profile-control"
              disabled={updateEmail.isPending}
              value={email}
              onChange={(event) => {
                setError(null);
                setSuccess(null);
                setEmail(event.target.value);
              }}
            />
          </Field>
          <Field label="Current password">
            <Input
              type="password"
              required
              autoComplete="current-password"
              className="profile-control"
              disabled={updateEmail.isPending}
              value={currentPassword}
              onChange={(event) => {
                setError(null);
                setSuccess(null);
                setCurrentPassword(event.target.value);
              }}
            />
          </Field>
          {error && <p role="alert" className="profile-status profile-status-error">{error}</p>}
          <div className="profile-editor-actions">
            <Button type="button" variant="outline" className="profile-action" disabled={updateEmail.isPending} onClick={closeEditor}>
              Cancel
            </Button>
            <Button type="submit" className="profile-action" disabled={updateEmail.isPending}>
              {updateEmail.isPending ? "Changing…" : "Change email"}
            </Button>
          </div>
        </ProfileCredentialDialog>
      )}
      {success && <p role="status" className="profile-status profile-status-success">{success}</p>}
    </div>
  );
}

/** The server answered a first password with 401: GitHub has not confirmed this account in this session, or its confirmation ran out (ADR 0081). */
class GitHubConfirmationExpired extends Error {
  constructor() {
    super("Your GitHub confirmation has expired. Confirm with GitHub again.");
  }
}

function PasswordSection({
  user,
  githubReturn,
  open,
  onOpenChange,
}: {
  user: User;
  /** What the GitHub round trip answered when it sent the browser back here, if it did. */
  githubReturn: "error" | "taken" | "reauthed" | "reauth-error" | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  // An account made with GitHub has no password yet: it sets one without a current password, but only after
  // GitHub has approved its own account again in this session (ADR 0081).
  const settingFirst = !user.hasPassword;
  const [confirmed, setConfirmed] = useState(settingFirst && githubReturn === "reauthed");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(
    settingFirst && githubReturn === "reauth-error" ? "GitHub did not confirm this account. Use the GitHub account connected to it." : null,
  );
  const [success, setSuccess] = useState<string | null>(null);
  const editorId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  const updatePassword = useMutation({
    mutationFn: async () => {
      const response = await api.auth.password.$post({
        json: settingFirst ? { newPassword } : { currentPassword, newPassword },
      });
      if (!response.ok) {
        if (response.status === 401) {
          if (settingFirst) throw new GitHubConfirmationExpired();
          throw new Error("Current password is incorrect.");
        }
        if (response.status === 429) throw new Error("Too many attempts. Try again later.");
        if (response.status === 400) throw new Error("Choose a less predictable password.");
        throw new Error("Could not update your password.");
      }
      return await response.json();
    },
    onSuccess: () => {
      if (settingFirst) {
        const updatedUser: User = { ...user, hasPassword: true };
        queryClient.setQueryData(meQuery.queryKey, updatedUser);
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(`Password ${settingFirst ? "set" : "updated"}. Other sessions were signed out.`);
      setError(null);
      onOpenChange(false);
      restoreFocusSoon(triggerRef.current);
    },
    onError: (err: Error) => {
      setError(err.message);
      setSuccess(null);
      // The confirmation was spent or has run out: back to the GitHub step.
      if (err instanceof GitHubConfirmationExpired) {
        setConfirmed(false);
        setNewPassword("");
        setConfirmPassword("");
        onOpenChange(false);
        restoreFocusSoon(triggerRef.current);
      }
    },
  });

  // The first password starts with GitHub: the page leaves for it and comes back with `?github=reauthed`.
  const confirmWithGitHub = useMutation({
    mutationFn: async () => {
      const response = await api.auth.github.reauth.$post();
      if (!response.ok) {
        if (response.status === 429) throw new Error("Too many attempts. Try again later.");
        if (response.status === 503) throw new Error("GitHub is not set up yet.");
        throw new Error("Could not reach GitHub.");
      }
      return (await response.json()).url;
    },
    onSuccess: (url) => window.location.assign(url),
    onError: (err: Error) => setError(err.message),
  });
  // On success the page is leaving for GitHub: keep the button locked until it does.
  const confirming = confirmWithGitHub.isPending || confirmWithGitHub.isSuccess;

  useEffect(() => {
    if (open) firstInputRef.current?.focus();
  }, [open]);
  // Back from GitHub with the account confirmed: the form is what comes next.
  useEffect(() => {
    if (confirmed) onOpenChange(true);
  }, [confirmed, onOpenChange]);

  // A first password has a form only once GitHub has confirmed the account; until then the button goes to GitHub.
  const opensForm = !settingFirst || confirmed;
  const openEditor = () => {
    if (!opensForm) {
      setSuccess(null);
      setError(null);
      confirmWithGitHub.reset();
      confirmWithGitHub.mutate();
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
    onOpenChange(true);
  };
  const closeEditor = () => {
    if (updatePassword.isPending) return;
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
    onOpenChange(false);
    restoreFocusSoon(triggerRef.current);
  };

  return (
    <div className="profile-field profile-credential">
      <div className="profile-row">
        <div className="profile-row-identity">
          <strong>Password</strong>
          <span>
            {settingFirst
              ? "Add a password so you can sign in without GitHub. GitHub confirms it is you first."
              : "Update your sign-in password."}
          </span>
        </div>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          className="profile-action"
          aria-expanded={opensForm ? open : undefined}
          aria-controls={opensForm ? editorId : undefined}
          hidden={open}
          disabled={confirming}
          onClick={openEditor}
        >
          {confirming ? "Opening GitHub…" : settingFirst ? "Set a password" : "Change password"}
        </Button>
      </div>
      {open && (
        <ProfileCredentialDialog
          title={settingFirst ? "Set a password" : "Change password"}
          formLabel={settingFirst ? "Set a password" : "Change password"}
          description={settingFirst ? "GitHub confirmed it is you. Choose a password for your Foxban account." : "Choose a new password for your Foxban account."}
          formId={editorId}
          busy={updatePassword.isPending}
          onClose={closeEditor}
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setSuccess(null);
            const problem = newPasswordProblem(newPassword);
            if (problem) {
              setError(problem);
              return;
            }
            if (newPassword !== confirmPassword) {
              setError("New passwords do not match.");
              return;
            }
            updatePassword.mutate();
          }}
        >
          {!settingFirst && (
            <Field label="Current password">
              <Input
                ref={firstInputRef}
                type="password"
                required
                autoComplete="current-password"
                className="profile-control"
                disabled={updatePassword.isPending}
                value={currentPassword}
                onChange={(event) => {
                  setError(null);
                  setSuccess(null);
                  setCurrentPassword(event.target.value);
                }}
              />
            </Field>
          )}
          <Field
            label="New password"
            hint="Use 8–256 characters; avoid common, repeated, or sequential patterns."
          >
            <Input
              ref={settingFirst ? firstInputRef : undefined}
              type="password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              autoComplete="new-password"
              className="profile-control"
              disabled={updatePassword.isPending}
              value={newPassword}
              onChange={(event) => {
                setError(null);
                setSuccess(null);
                setNewPassword(event.target.value);
              }}
            />
          </Field>
          <Field
            label="Confirm new password"
            hint="Use 8–256 characters; avoid common, repeated, or sequential patterns."
          >
            <Input
              type="password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              autoComplete="new-password"
              className="profile-control"
              disabled={updatePassword.isPending}
              value={confirmPassword}
              onChange={(event) => {
                setError(null);
                setSuccess(null);
                setConfirmPassword(event.target.value);
              }}
            />
          </Field>
          {error && <p role="alert" className="profile-status profile-status-error">{error}</p>}
          <div className="profile-editor-actions">
            <Button type="button" variant="outline" className="profile-action" disabled={updatePassword.isPending} onClick={closeEditor}>
              Cancel
            </Button>
            <Button type="submit" className="profile-action" disabled={updatePassword.isPending}>
              {updatePassword.isPending ? (settingFirst ? "Saving…" : "Changing…") : settingFirst ? "Set password" : "Change password"}
            </Button>
          </div>
        </ProfileCredentialDialog>
      )}
      {!open && error && <p role="alert" className="profile-status profile-status-error">{error}</p>}
      {success && <p role="status" className="profile-status profile-status-success">{success}</p>}
    </div>
  );
}

function GitHubSection({
  user,
  githubError,
  open,
  onOpenChange,
}: {
  user: User;
  githubError: "error" | "taken" | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [success, setSuccess] = useState<string | null>(null);
  const [clearedGithubError, setClearedGithubError] = useState(false);
  // An account with a password proves it before the link starts (ADR 0081); one without has nothing to prove.
  const [currentPassword, setCurrentPassword] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const editorId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  const disconnect = useMutation({
    mutationFn: async () => {
      const response = await api.me.$patch({ json: { githubLogin: null } });
      if (!response.ok) throw new Error("Could not disconnect GitHub.");
      return (await response.json()) as User;
    },
    onSuccess: (updatedUser) => {
      queryClient.setQueryData(meQuery.queryKey, updatedUser);
      void queryClient.invalidateQueries({ queryKey: ["board-members"] });
      setSuccess("GitHub disconnected.");
    },
    onError: () => {
      setSuccess(null);
    },
  });

  const link = useMutation({
    mutationFn: async () => {
      const response = await api.auth.github.link.$post({ json: user.hasPassword ? { currentPassword } : {} });
      if (!response.ok) {
        if (response.status === 401) throw new Error("Current password is incorrect.");
        if (response.status === 429) throw new Error("Too many attempts. Try again later.");
        if (response.status === 503) throw new Error("GitHub is not set up yet.");
        throw new Error("Could not connect GitHub.");
      }
      return (await response.json()).url;
    },
    onSuccess: (url) => {
      setCurrentPassword("");
      window.location.assign(url);
    },
    onError: (err: Error) => {
      setLinkError(err.message);
    },
  });
  // On success the page is leaving for GitHub: keep the form locked until it does.
  const linking = link.isPending || link.isSuccess;

  useEffect(() => {
    if (open) firstInputRef.current?.focus();
  }, [open]);

  const startLink = () => {
    setSuccess(null);
    setClearedGithubError(true);
    setLinkError(null);
    setCurrentPassword("");
    link.reset();
    if (user.hasPassword) onOpenChange(true);
    else link.mutate();
  };
  const closeEditor = () => {
    if (linking) return;
    setCurrentPassword("");
    setLinkError(null);
    onOpenChange(false);
    restoreFocusSoon(triggerRef.current);
  };

  // While the dialog is open it shows a link error itself.
  const errorMessage =
    disconnect.error?.message ??
    (open ? null : linkError) ??
    (githubError && !clearedGithubError
      ? githubError === "taken"
        ? "That GitHub account is already linked to another foxban account."
        : "GitHub connection failed."
      : null);

  return (
    <div className="profile-field profile-github">
      <div className="profile-row">
        <span className="profile-github-tile">
          <GitBranch aria-hidden="true" />
        </span>
        <div className="profile-row-identity">
          <strong>GitHub</strong>
          {user.githubLogin ? (
            <span className="profile-github-state">
              <span className="profile-badge">
                <Check aria-hidden="true" />
                Connected
              </span>
              <span className="profile-handle">@{user.githubLogin}</span>
            </span>
          ) : (
            <span className="profile-github-state">
              <span className="profile-badge">Not connected</span>
            </span>
          )}
        </div>
        <div className="profile-account-action">
          {user.githubLogin ? (
            <Button
              type="button"
              variant="outline"
              className="profile-action"
              onClick={() => {
                setSuccess(null);
                setClearedGithubError(true);
                if (disconnect.error) disconnect.reset();
                disconnect.mutate();
              }}
              disabled={disconnect.isPending || !user.hasPassword}
            >
              {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
            </Button>
          ) : (
            <Button
              ref={triggerRef}
              type="button"
              className="profile-action"
              aria-expanded={user.hasPassword ? open : undefined}
              aria-controls={user.hasPassword ? editorId : undefined}
              hidden={open}
              disabled={linking}
              onClick={startLink}
            >
              {linking && !user.hasPassword ? "Connecting…" : "Connect GitHub"}
            </Button>
          )}
        </div>
      </div>
      {user.githubLogin && !user.hasPassword && (
        <p className="profile-hint">Set a password before disconnecting GitHub, so you can still sign in.</p>
      )}
      {open && (
        <ProfileCredentialDialog
          title="Connect GitHub"
          formLabel="Connect GitHub"
          description="Enter your current password to connect GitHub."
          formId={editorId}
          busy={linking}
          onClose={closeEditor}
          onSubmit={(event) => {
            event.preventDefault();
            setLinkError(null);
            link.mutate();
          }}
        >
          <Field label="Current password">
            <Input
              ref={firstInputRef}
              type="password"
              required
              maxLength={PASSWORD_MAX_LENGTH}
              autoComplete="current-password"
              className="profile-control"
              disabled={linking}
              value={currentPassword}
              onChange={(event) => {
                setLinkError(null);
                setCurrentPassword(event.target.value);
              }}
            />
          </Field>
          {linkError && <p role="alert" className="profile-status profile-status-error">{linkError}</p>}
          <div className="profile-editor-actions">
            <Button type="button" variant="outline" className="profile-action" disabled={linking} onClick={closeEditor}>
              Cancel
            </Button>
            <Button type="submit" className="profile-action" disabled={linking}>
              {linking ? "Connecting…" : "Connect GitHub"}
            </Button>
          </div>
        </ProfileCredentialDialog>
      )}
      {errorMessage && <p role="alert" className="profile-status profile-status-error">{errorMessage}</p>}
      {success && <p role="status" className="profile-status profile-status-success">{success}</p>}
    </div>
  );
}

const TIMEZONE_ROW_CLASS =
  "h-8 pointer-coarse:h-11 w-full justify-start px-2 font-normal text-popover-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none";

interface TimezonePickerProps {
  value: string;
  browserZone: string | null;
  availableZones: string[];
  disabled?: boolean;
  onChange: (value: string) => void;
}

function TimezonePicker({
  value,
  browserZone,
  availableZones,
  disabled = false,
  onChange,
}: TimezonePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  };

  const pick = (zoneValue: string) => {
    onChange(zoneValue);
    close();
  };

  const onKeyDown = (event: {
    key: string;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => {
    if (event.key === "Escape") {
      if (!open) return;
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!open) {
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      setOpen(true);
      return;
    }
    event.preventDefault();
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>('input, [role="option"]') ?? [],
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = index === -1 ? 0 : Math.min(Math.max(index + step, 0), items.length - 1);
    items[next].focus();
  };

  const automaticLabel = browserZone
    ? `Automatic (${browserZone})`
    : "Automatic (unavailable)";

  const selectedLabel =
    value === "automatic"
      ? automaticLabel
      : value;

  const needle = query.trim().toLowerCase();
  const matches = availableZones.filter((zone) =>
    zone.toLowerCase().includes(needle),
  );
  const automaticMatches =
    needle === "" ||
    automaticLabel.toLowerCase().includes(needle) ||
    "automatic".includes(needle) ||
    (browserZone !== null && browserZone.toLowerCase().includes(needle));

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-label="Timezone"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="h-9 w-full min-w-0 justify-start px-3 font-normal text-foreground pointer-coarse:min-h-11"
      >
        <span className="min-w-0 flex-1 truncate text-left">{selectedLabel}</span>
        <ChevronDown aria-hidden className="ml-auto size-4 text-muted-foreground shrink-0" />
      </Button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 flex flex-col gap-1 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-popover">
          <Input
            ref={searchInputRef}
            autoFocus
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-label="Search timezones"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                if (automaticMatches) {
                  pick("automatic");
                } else if (matches.length > 0) {
                  pick(matches[0]);
                }
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                if (query !== "") setQuery("");
                else close();
              }
            }}
            placeholder="Search timezones…"
            autoComplete="off"
            className="h-8 px-2 py-1"
          />
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Timezones"
            className="max-h-60 overflow-y-auto"
          >
            {automaticMatches && (
              <li>
                <Button
                  type="button"
                  role="option"
                  variant="ghost"
                  size="sm"
                  aria-selected={value === "automatic"}
                  onClick={() => pick("automatic")}
                  className={TIMEZONE_ROW_CLASS}
                >
                  <span className="min-w-0 flex-1 truncate text-left">
                    {automaticLabel}
                  </span>
                  {value === "automatic" && (
                    <Check aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                </Button>
              </li>
            )}
            {matches.map((zone) => (
              <li key={zone}>
                <Button
                  type="button"
                  role="option"
                  variant="ghost"
                  size="sm"
                  aria-selected={zone === value}
                  onClick={() => pick(zone)}
                  className={TIMEZONE_ROW_CLASS}
                >
                  <span className="min-w-0 flex-1 truncate text-left">{zone}</span>
                  {zone === value && (
                    <Check aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                </Button>
              </li>
            ))}
          </ul>
          {!automaticMatches && matches.length === 0 && (
            <div className="px-2 py-1 text-sm text-muted-foreground">
              No matching timezones
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TimezoneSection({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const browserZone = (() => {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return zone && zone.length > 0 ? zone : null;
    } catch {
      return null;
    }
  })();

  const availableZones = (() => {
    const set = new Set<string>();
    if (typeof Intl !== "undefined" && "supportedValuesOf" in Intl) {
      try {
        for (const zone of Intl.supportedValuesOf("timeZone")) {
          set.add(zone);
        }
      } catch {
        // Fallback below
      }
    }
    if (browserZone) {
      set.add(browserZone);
    }
    if (user.timezone) {
      set.add(user.timezone);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  })();

  const [selected, setSelected] = useState<string>(user.timezone ?? "automatic");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const updateTimezone = useMutation({
    mutationFn: async (targetTz: string | null) => {
      const response = await api.me.$patch({ json: { timezone: targetTz } });
      if (!response.ok) {
        throw new Error("Could not update your timezone.");
      }
      return (await response.json()) as User;
    },
    onSuccess: (updatedUser) => {
      queryClient.setQueryData(meQuery.queryKey, updatedUser);
      setSelected(updatedUser.timezone ?? "automatic");
      setSuccess("Timezone updated.");
      setError(null);
    },
    onError: (err: Error) => {
      setError(err.message);
      setSuccess(null);
    },
  });

  const onTimezoneChange = (val: string) => {
    setSelected(val);
    setError(null);
    setSuccess(null);
  };

  return (
    <form
      className="profile-field profile-timezone"
      onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError(null);
        setSuccess(null);
        const nextTz = selected === "automatic" ? null : selected;
        updateTimezone.mutate(nextTz);
      }}
    >
      <div className="profile-timezone-row">
        <div className="profile-timezone-picker">
          <TimezonePicker
            value={selected}
            browserZone={browserZone}
            availableZones={availableZones}
            disabled={updateTimezone.isPending}
            onChange={onTimezoneChange}
          />
        </div>
        <Button
          type="submit"
          className="profile-action"
          disabled={
            updateTimezone.isPending ||
            selected === (user.timezone ?? "automatic")
          }
        >
          {updateTimezone.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      {error && <p role="alert" className="profile-status profile-status-error">{error}</p>}
      {success && <p role="status" className="profile-status profile-status-success">{success}</p>}
    </form>
  );
}
