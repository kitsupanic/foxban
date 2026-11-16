import { useEffect, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { Member } from "../lib/api";
import type { PresenceMap } from "../lib/presence";
import { Avatar } from "./Avatar";
import { Button } from "./ui/button";

export function formatRelativeTime(timestamp: number, now: number): string {
  const diffMs = Math.max(0, now - timestamp);
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMin < 1) return "just now";
  if (diffHours < 1) return `${diffMin}m ago`;
  if (diffDays < 1) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

export function formatMemberTime(timezone: string | null, now: Date): string {
  if (!timezone) return "Local time unavailable";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    }).format(now);
  } catch {
    return "Local time unavailable";
  }
}

export function MemberSidebar({
  membersQuery,
  presenceMap,
  ownerId,
}: {
  membersQuery: UseQueryResult<Member[], Error>;
  presenceMap: PresenceMap;
  ownerId?: string | null;
}) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (membersQuery.isPending) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        Loading members…
      </div>
    );
  }

  if (membersQuery.isError) {
    return (
      <div className="p-4 space-y-2">
        <p className="text-xs text-destructive">Could not load board members.</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => membersQuery.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }

  const members = membersQuery.data ?? [];
  if (members.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        No board members yet.
      </div>
    );
  }

  // Sort online members first, then offline members, preserving API's name order within each group
  const onlineMembers: Member[] = [];
  const offlineMembers: Member[] = [];

  for (const m of members) {
    const presence = presenceMap[m.id];
    if (presence?.online) {
      onlineMembers.push(m);
    } else {
      offlineMembers.push(m);
    }
  }

  const sortedMembers = [...onlineMembers, ...offlineMembers];

  return (
    <ul className="divide-y divide-border overflow-y-auto">
      {sortedMembers.map((member) => {
        const presence = presenceMap[member.id];
        const isOnline = Boolean(presence?.online);
        const lastSeenAt = presence?.lastSeenAt ?? null;
        const timezone = presence?.timezone ?? null;

        let statusText: string;
        if (isOnline) {
          statusText = "Online";
        } else if (lastSeenAt !== null) {
          statusText = `Last online ${formatRelativeTime(lastSeenAt, now.getTime())}`;
        } else {
          statusText = "Last online unknown";
        }

        const localTimeText = formatMemberTime(timezone, now);

        return (
          <li key={member.id} className="p-3 space-y-1">
            <div className="flex items-center gap-2 min-w-0">
              <Avatar
                name={member.name}
                githubLogin={member.githubLogin}
                avatarVersion={member.avatarVersion}
                userId={member.id}
              />
              <span className="truncate text-sm font-medium text-foreground">
                {member.name}
              </span>
              {ownerId && member.id === ownerId && (
                <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                  Owner
                </span>
              )}
              {member.isAdmin && (
                <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                  Admin
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                aria-hidden
                className={`inline-block size-2 rounded-full shrink-0 ${
                  isOnline ? "bg-emerald-500" : "bg-muted-foreground/50"
                }`}
              />
              <span className="truncate">{statusText}</span>
            </div>
            <div className="text-[11px] text-muted-foreground/80">
              {localTimeText}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
