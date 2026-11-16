import { useState } from "react";
import { initials } from "../lib/initials";

/** The size-5 initials circle, shared by every avatar surface. */
export const AVATAR_CLASS =
  "flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-secondary-foreground";

/**
 * A user's avatar. Source precedence:
 * 1. Uploaded avatar (/users/<userId>/avatar/<avatarVersion>)
 * 2. Verified GitHub avatar (github.com/<githubLogin>.png?size=48)
 * 3. Initials circle
 */
export function Avatar({
  name,
  githubLogin,
  avatarVersion,
  userId,
}: {
  name: string;
  githubLogin?: string | null;
  avatarVersion?: string | null;
  userId?: string | null;
}) {
  const [failedAvatarVersion, setFailedAvatarVersion] = useState<string | null>(null);
  const [failedLogin, setFailedLogin] = useState<string | null>(null);

  if (userId && avatarVersion && failedAvatarVersion !== avatarVersion) {
    return (
      <img
        aria-hidden
        alt=""
        src={`/users/${userId}/avatar/${avatarVersion}`}
        referrerPolicy="no-referrer"
        className="size-5 shrink-0 rounded-full object-cover"
        onError={() => setFailedAvatarVersion(avatarVersion)}
      />
    );
  }

  if (githubLogin && failedLogin !== githubLogin) {
    return (
      <img
        aria-hidden
        alt=""
        src={`https://github.com/${githubLogin}.png?size=48`}
        referrerPolicy="no-referrer"
        className="size-5 shrink-0 rounded-full object-cover"
        onError={() => setFailedLogin(githubLogin)}
      />
    );
  }
  return (
    <span aria-hidden className={AVATAR_CLASS}>
      {initials(name)}
    </span>
  );
}
