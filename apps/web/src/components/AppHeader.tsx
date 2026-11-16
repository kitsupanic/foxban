import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDown, GitBranch, Globe, House, LayoutGrid, Mail, Menu, Plus, Plug, Settings, UserRound, Users, X } from "lucide-react";
import { api } from "../lib/api";
import { resetAccessAttempts } from "../lib/access-attempt";
import { meQuery } from "../lib/auth";
import { workspacesQuery } from "../lib/workspaces";
import { restoreFocusSoon } from "../lib/focus";
import { inertElements } from "../lib/inert";
import { cn } from "../lib/utils";
import { Avatar } from "./Avatar";
import { Button } from "./ui/button";
import { NavigationHint } from "./NavigationHint";

type HeaderMenu = { kind: "account"; surface: "mobile" | "sidebar" };

export interface AppHeaderProps {
  /** The workspace named by the route or owning the open board; none on Home and Account pages. */
  expandedWorkspaceId?: string;
  boardCount: number | null;
  compact?: boolean;
  onCreateWorkspace: () => void;
}

export function AppHeader({ expandedWorkspaceId, boardCount, compact = false, onCreateWorkspace }: AppHeaderProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: user } = useQuery(meQuery);
  const workspaces = useQuery(workspacesQuery);
  const [openMenu, setOpenMenu] = useState<HeaderMenu | null>(null);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const id = useId();
  const mobileNavigationId = `${id}-navigation`;
  const menuId = `${id}-menu`;
  const mobileNavigationTriggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<"first" | "last">("first");
  const typeahead = useRef({ text: "", time: 0 });
  const rootRef = useRef<HTMLElement>(null);
  const menuItems = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled):not([aria-disabled="true"])') ?? []);
  const closeMenu = (restore = false) => {
    setOpenMenu(null);
    if (restore && menuTriggerRef.current?.getClientRects().length) menuTriggerRef.current.focus();
  };
  const showMenu = (kind: HeaderMenu["kind"], surface: HeaderMenu["surface"], trigger: HTMLButtonElement, edge: "first" | "last" = "first") => {
    menuTriggerRef.current = trigger;
    initialFocus.current = edge;
    typeahead.current = { text: "", time: 0 };
    setMobileNavigationOpen(false);
    setOpenMenu({ kind, surface });
  };
  const menuButtonProps = (kind: HeaderMenu["kind"], surface: HeaderMenu["surface"]) => ({
    id: `${id}-${kind}-${surface}`,
    "aria-haspopup": "menu" as const,
    "aria-expanded": openMenu?.kind === kind && openMenu.surface === surface,
    "aria-controls": openMenu?.kind === kind && openMenu.surface === surface ? menuId : undefined,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      if (openMenu?.kind === kind && openMenu.surface === surface) closeMenu();
      else showMenu(kind, surface, event.currentTarget);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      event.stopPropagation();
      showMenu(kind, surface, event.currentTarget, event.key === "ArrowUp" ? "last" : "first");
    },
  });
  useLayoutEffect(() => {
    if (!openMenu) return;
    const items = menuItems();
    (initialFocus.current === "last" ? items.at(-1) : items[0])?.focus();
  }, [openMenu]);
  // The drawer is modal: everything behind it is inert, and focus starts inside.
  useEffect(() => {
    if (!mobileNavigationOpen) return;
    const root = rootRef.current;
    const behind = [root?.querySelector<HTMLElement>(".boards-mobile-banner"), root?.parentElement?.querySelector<HTMLElement>(":scope > .boards-main")]
      .filter((element): element is HTMLElement => !!element);
    const release = inertElements(behind);
    drawerRef.current?.querySelector<HTMLElement>("button, a[href]")?.focus();
    return release;
  }, [mobileNavigationOpen]);
  useEffect(() => {
    if (!openMenu && !mobileNavigationOpen) return;
    const close = (event: PointerEvent) => {
      if (openMenu && !menuRef.current?.contains(event.target as Node) && !menuTriggerRef.current?.contains(event.target as Node)) setOpenMenu(null);
      if (!rootRef.current?.contains(event.target as Node)) setMobileNavigationOpen(false);
    };
    const onFocus = (event: FocusEvent) => {
      // Menu items are outside the Tab sequence. Let the browser move to the
      // next control before removing the menu, preserving native Tab order.
      if (openMenu && !menuRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const onResize = () => { setOpenMenu(null); setMobileNavigationOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("resize", onResize);
    };
  }, [openMenu, mobileNavigationOpen]);
  const logout = useMutation({ mutationFn: async () => { const response = await api.auth.logout.$post(); if (!response.ok) throw new Error("Could not sign out."); }, onSuccess: async () => { queryClient.clear(); resetAccessAttempts(); queryClient.setQueryData(meQuery.queryKey, null); await navigate({ to: "/login" }); } });
  const closeDrawer = () => {
    // Hiding the drawer would only drop focus to the body after the frame restoreFocusSoon runs in.
    (document.activeElement as HTMLElement | null)?.blur();
    setMobileNavigationOpen(false);
    restoreFocusSoon(mobileNavigationTriggerRef.current);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((mobileNavigationOpen || openMenu) && ["n", "c", "m", "/"].includes(event.key)) event.stopPropagation();
    if (event.key === "Escape" && (openMenu || mobileNavigationOpen)) {
      event.preventDefault();
      event.stopPropagation();
      if (openMenu) closeMenu(true);
      else closeDrawer();
      return;
    }
    if (event.key === "Tab" && mobileNavigationOpen) {
      // Wrap at the drawer's ends; the rest of the page is inert.
      const items = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]") ?? []);
      const edge = event.shiftKey ? items[0] : items.at(-1);
      if (document.activeElement === edge) {
        event.preventDefault();
        (event.shiftKey ? items.at(-1) : items[0])?.focus();
      }
      return;
    }
    if (!openMenu || !menuRef.current?.contains(event.target as Node)) return;
    if (event.key === "Tab") return;
    const items = menuItems();
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      items[current]?.click();
    } else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      const text = (Date.now() - typeahead.current.time < 700 ? typeahead.current.text : "") + event.key.toLocaleLowerCase();
      typeahead.current = { text, time: Date.now() };
      const prefix = [...text].every((letter) => letter === text[0]) ? text[0]! : text;
      const start = prefix.length === 1 ? current + 1 : current;
      for (let step = 0; step < items.length; step++) {
        const item = items[(Math.max(0, start) + step) % items.length]!;
        if ((item.dataset.menuLabel ?? item.textContent ?? "").trim().toLocaleLowerCase().startsWith(prefix)) {
          item.focus();
          break;
        }
      }
    }
  };
  const sidebarLabelClass = compact ? "app-navigation-label sr-only" : undefined;
  const memberWorkspaces = workspaces.data?.filter((item) => item.access === "member") ?? [];
  // The rail is the collapsed sidebar: icons and initials tiles only. The drawer always shows labels.
  const mainLinks = (surface: HeaderMenu["surface"]) => {
    const rail = compact && surface === "sidebar";
    const labelClass = rail ? sidebarLabelClass : undefined;
    const hintEnabled = rail && !openMenu;
    const headingId = `${id}-workspaces-${surface}`;
    return <>
      <NavigationHint label="Home" enabled={hintEnabled}>{(hint) => <Link {...hint} to="/" activeOptions={{ exact: true }}><House /><span className={labelClass}>Home</span></Link>}</NavigationHint>
      <div className="workspace-list-heading">
        <span id={headingId} className={labelClass}>Workspaces</span>
        <NavigationHint label="New workspace" enabled={hintEnabled}>{(hint) => <Button {...hint} type="button" variant="ghost" size="icon-sm" aria-label="New workspace" onClick={() => { setMobileNavigationOpen(false); onCreateWorkspace(); }}><Plus /></Button>}</NavigationHint>
      </div>
      <ul className="workspace-list" aria-labelledby={headingId}>
        {memberWorkspaces.map((item) => <li key={item.id}>
          {item.id === expandedWorkspaceId && !rail
            ? <div className="workspace-row" data-expanded="true"><span className="workspace-initials" aria-hidden="true">{item.name.slice(0, 2).toUpperCase()}</span><span className={labelClass} title={item.name}>{item.name}</span></div>
            : <NavigationHint label={item.name} enabled={hintEnabled}>{(hint) => <Link {...hint} className="workspace-row" data-expanded={item.id === expandedWorkspaceId || undefined} to="/w/$workspaceId" params={{ workspaceId: item.id }}><span className="workspace-initials" aria-hidden="true">{item.name.slice(0, 2).toUpperCase()}</span><span className={labelClass} title={rail ? undefined : item.name}>{item.name}</span></Link>}</NavigationHint>}
          {item.id === expandedWorkspaceId && !rail && <ul className="workspace-sublist" aria-label={`${item.name} pages`}>
            <li><NavigationHint label="Boards" enabled={hintEnabled}>{(hint) => <Link {...hint} to="/w/$workspaceId" params={{ workspaceId: item.id }} activeOptions={{ exact: true }}><LayoutGrid /><span className={labelClass}>Boards</span>{boardCount !== null && <span className={cn("boards-nav-count", labelClass)}>{boardCount}</span>}</Link>}</NavigationHint></li>
            <li><NavigationHint label="Members" enabled={hintEnabled}>{(hint) => <Link {...hint} to="/w/$workspaceId/members" params={{ workspaceId: item.id }}><Users /><span className={labelClass}>Members</span></Link>}</NavigationHint></li>
            {item.role === "admin" && <li><NavigationHint label="Settings" enabled={hintEnabled}>{(hint) => <Link {...hint} to="/w/$workspaceId/settings" params={{ workspaceId: item.id }}><Settings /><span className={labelClass}>Settings</span></Link>}</NavigationHint></li>}
          </ul>}
        </li>)}
      </ul>
    </>;
  };
  const accountLinks = (surface: HeaderMenu["surface"]) => {
    const rail = compact && surface === "sidebar";
    const labelClass = rail ? sidebarLabelClass : undefined;
    const hintEnabled = rail && !openMenu;
    return <>
    <NavigationHint label="Profile" enabled={hintEnabled}>{(hint) => <Link {...hint} to="/profile"><UserRound /><span className={labelClass}>Profile</span></Link>}</NavigationHint>
    <NavigationHint label="MCP server" enabled={hintEnabled}>{(hint) => <Link {...hint} to="/mcp-server"><Plug /><span className={labelClass}>MCP server</span></Link>}</NavigationHint>
    {user?.isAdmin && <NavigationHint label="Account invites" enabled={hintEnabled}>{(hint) => <Link {...hint} to="/account-invites"><Mail /><span className={labelClass}>Account invites</span></Link>}</NavigationHint>}
    {user?.isAdmin && <NavigationHint label="GitHub" enabled={hintEnabled}>{(hint) => <Link {...hint} to="/account-github"><GitBranch /><span className={labelClass}>GitHub</span></Link>}</NavigationHint>}
    {user?.isAdmin && <NavigationHint label="All workspaces" enabled={hintEnabled}>{(hint) => <Link {...hint} to="/all-workspaces"><Globe /><span className={labelClass}>All workspaces</span></Link>}</NavigationHint>}
    </>;
  };
  const accountMenu = openMenu?.kind === "account" && <div ref={menuRef} id={menuId} role="menu" tabIndex={-1} aria-labelledby={`${id}-account-${openMenu.surface}`} className="boards-account-popover">
    <div className="boards-account-identity"><strong>{user?.name}</strong><span>{user?.email}</span></div>
    <Link role="menuitem" tabIndex={-1} to="/profile" onClick={() => closeMenu()}>Profile</Link>
    <Link role="menuitem" tabIndex={-1} to="/mcp-server" onClick={() => closeMenu()}>MCP server</Link>
    {user?.isAdmin && <Link role="menuitem" tabIndex={-1} to="/account-invites" onClick={() => closeMenu()}>Account invites</Link>}
    {user?.isAdmin && <Link role="menuitem" tabIndex={-1} to="/account-github" onClick={() => closeMenu()}>GitHub</Link>}
    {user?.isAdmin && <Link role="menuitem" tabIndex={-1} to="/all-workspaces" onClick={() => closeMenu()}>All workspaces</Link>}
    <Button role="menuitem" tabIndex={-1} variant="ghost" disabled={logout.isPending} onClick={() => logout.mutate()}>Sign out</Button>
    {logout.isError && <p role="alert">Could not sign out.</p>}
  </div>;
  return <header ref={rootRef} className="boards-header" onKeyDown={onKeyDown}>
    <div className="boards-mobile-banner">
      <Brand compact={compact} />
      <Link className="boards-mobile-home" to="/" activeOptions={{ exact: true }}><House /><span>Home</span></Link>
      <Button
        ref={mobileNavigationTriggerRef}
        type="button"
        variant="ghost"
        className="boards-mobile-menu"
        aria-label="Open navigation"
        aria-expanded={mobileNavigationOpen}
        aria-controls={mobileNavigationOpen ? mobileNavigationId : undefined}
        onClick={() => {
          setMobileNavigationOpen(true);
          setOpenMenu(null);
        }}
      >
        <Menu aria-hidden="true" />
        Menu
      </Button>
      <Button {...menuButtonProps("account", "mobile")} aria-label="Your account" className="boards-mobile-account" variant="ghost" size="icon">
        {user && <Avatar name={user.name} githubLogin={user.githubLogin} avatarVersion={user.avatarVersion} userId={user.id} />}
      </Button>
    </div>
    {mobileNavigationOpen && <>
    <div className="boards-mobile-backdrop" aria-hidden="true" onClick={closeDrawer} />
    <div
      ref={drawerRef}
      id={mobileNavigationId}
      role="dialog"
      aria-label="Navigation"
      className="boards-mobile-drawer"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a")) setMobileNavigationOpen(false);
      }}
    >
      <div className="boards-mobile-drawer-top">
        <Brand compact={false} />
        <Button type="button" variant="ghost" size="icon" aria-label="Close navigation" onClick={closeDrawer}><X aria-hidden="true" /></Button>
      </div>
      <nav className="boards-sidebar-nav" aria-label="Main navigation">{mainLinks("mobile")}</nav>
      <div className="boards-sidebar-caption">Account</div>
      <nav className="boards-sidebar-nav" aria-label="Account navigation">{accountLinks("mobile")}</nav>
    </div>
    </>}
    <aside className="boards-sidebar">
      <Brand compact={compact} />
      <div className="boards-sidebar-scroll"><nav className="boards-sidebar-nav" aria-label="Main navigation">{mainLinks("sidebar")}</nav></div>
      <div className={cn("boards-sidebar-caption", compact && "sr-only")}>Account</div>
      <nav className="boards-sidebar-nav" aria-label="Account navigation">{accountLinks("sidebar")}</nav>
      <div className="boards-sidebar-account">
        <NavigationHint label="Your account" enabled={compact && !openMenu}>{(hint) => <Button {...hint} {...menuButtonProps("account", "sidebar")} variant="ghost" aria-label="Your account">
          {user && <Avatar name={user.name} githubLogin={user.githubLogin} avatarVersion={user.avatarVersion} userId={user.id} />}
          <span className={sidebarLabelClass}>{user?.name}</span><ChevronsUpDown />
        </Button>}</NavigationHint>
      </div>
    </aside>
    {accountMenu}
  </header>;
}

function Brand({ compact }: { compact: boolean }) {
  return <div className="boards-brand"><span className="boards-brand-mark"><img src="/favicon-192.png" alt="" /></span><span className={compact ? "sr-only" : undefined}>Foxban</span></div>;
}
