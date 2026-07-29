import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  Bell,
  Trash2,
  CheckCheck,
  CloudSun,
  MessageSquare,
  Sparkles,
  LoaderCircle,
  WifiOff,
  X
} from "lucide-react";

import { useAuth } from "@/context/AuthContext";
import { useTranslation } from "@/i18n";
import { clearAppBadgeAndServer } from "@/lib/pushNotifications";
import {
  Popover,
  PopoverTrigger,
  PopoverContent
} from "@/components/ui/popover";
import {
  Drawer,
  DrawerTrigger,
  DrawerContent,
  DrawerClose
} from "@/components/ui/drawer";
import {
  Tabs,
  TabsList,
  TabsTrigger
} from "@/components/ui/tabs";

export interface InAppNotification {
  id: string;
  tenantId: string | null;
  userId: string;
  title: string;
  body: string;
  url: string | null;
  category: "weather" | "community" | "curation" | "system";
  read: boolean;
  createdAt: string;
}

// The list page plus a server-authoritative unread total (counts ALL of the
// user's unread rows, not just the 50 returned in `notifications`).
interface FeedData {
  notifications: InAppNotification[];
  unreadCount: number;
}

// Desktop (Popover) vs mobile (Drawer) must be mutually exclusive at the React
// level — NOT via CSS `hidden`/`md:hidden`. Both Radix Popover and vaul Drawer
// portal their content (and the Drawer's full-screen scrim) to document.body,
// so a wrapper div's `hidden` class never reaches the portaled node. Gating both
// on one `isOpen` therefore opened BOTH surfaces at once: the Popover panel plus
// the Drawer's bg-black/80 overlay that swallowed every click. Resolving the
// breakpoint in JS and mounting exactly one primitive is the fix.
const DESKTOP_QUERY = "(min-width: 768px)"; // Tailwind `md`
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(DESKTOP_QUERY).matches
      : true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    setIsDesktop(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

const TABS: { value: string; labelKey: string }[] = [
  { value: "all", labelKey: "notificationFeed.tabAll" },
  { value: "weather", labelKey: "notificationFeed.tabWeather" },
  { value: "community", labelKey: "notificationFeed.tabCommunity" },
  { value: "system", labelKey: "notificationFeed.tabUpdates" },
];

export function NotificationFeed() {
  const { authToken } = useAuth();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<string>("all");
  const [isOpen, setIsOpen] = useState(false);
  const isDesktop = useIsDesktop();

  const feedKey = ["notifications", authToken] as const;

  // Conditional-GET memo: Express auto-ETags every res.json body and answers a
  // matching If-None-Match with an empty 304 (the Vercel /api proxy forwards
  // both), so replaying the last 200's ETag turns the steady-state poll — by far
  // the most common case, nothing changed — from a full 50-row JSON page into a
  // bodyless 304. We keep the last 200 payload alongside its ETag (scoped to the
  // token so a sign-in switch can't replay another user's snapshot) and hand it
  // back on 304, which is byte-identical to what the server would have re-sent.
  const conditionalRef = React.useRef<{ token: string; etag: string; data: FeedData } | null>(null);

  // 1. Query: Fetch notifications from API. Firing is entirely server-driven —
  // there is no client-side notification generation, so React Query's keyed cache
  // is the dedupe boundary (one in-flight request per token, shared across the
  // desktop + mobile triggers below).
  const { data, isLoading, isError, refetch, isFetching } = useQuery<FeedData>({
    queryKey: feedKey,
    queryFn: async () => {
      if (!authToken) return { notifications: [], unreadCount: 0 };
      const headers: Record<string, string> = {
        Authorization: `Bearer ${authToken}`
      };
      const prior = conditionalRef.current;
      const canRevalidate = prior !== null && prior.token === authToken;
      if (canRevalidate) headers["If-None-Match"] = prior.etag;
      const res = await fetch("/api/notifications", { headers });
      if (res.status === 304 && canRevalidate) return prior.data;
      if (!res.ok) throw new Error("Failed to fetch notifications");
      const json = await res.json();
      const next: FeedData = {
        notifications: (json.notifications || []) as InAppNotification[],
        unreadCount: typeof json.unreadCount === "number" ? json.unreadCount : 0,
      };
      const etag = res.headers.get("etag");
      conditionalRef.current = etag ? { token: authToken, etag, data: next } : null;
      return next;
    },
    enabled: !!authToken,
    // Poll fast (15s) only while the panel is actually open; relax to 60s while
    // it is closed — the badge count tolerates a minute of staleness and the
    // closed state is where sessions spend nearly all their time, so this cuts
    // steady-state poll traffic ~4x. refetchIntervalInBackground stays at its
    // default (false), so hidden tabs never poll at all.
    refetchInterval: isOpen ? 15000 : 60000,
    staleTime: 15000, // align freshness window with the fastest poll cadence
    refetchOnWindowFocus: false // the poll already keeps it fresh; avoid focus-storm refetches
  });

  // Optimistic cache helpers — every mutation updates the cache immediately so a
  // tap feels instant, then rolls back on error and reconciles on settle. Without
  // this the unread dot / item styling lingered for a full network round-trip.
  const patchFeed = (updater: (prev: FeedData) => FeedData) =>
    queryClient.setQueryData<FeedData>(feedKey, (prev) => (prev ? updater(prev) : prev));

  const beginOptimistic = async (updater: (prev: FeedData) => FeedData) => {
    await queryClient.cancelQueries({ queryKey: feedKey });
    const previous = queryClient.getQueryData<FeedData>(feedKey);
    patchFeed(updater);
    return { previous };
  };

  const rollback = (ctx: { previous?: FeedData } | undefined) => {
    if (ctx?.previous) queryClient.setQueryData(feedKey, ctx.previous);
  };

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["notifications"] });

  // Opening the panel revalidates immediately (a bodyless 304 when nothing
  // changed), so the relaxed 60s closed-state cadence never makes the opened
  // list staler than the old always-15s poll did.
  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) void refetch();
  };

  // 2. Mutations (all optimistic)
  const markReadMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/notifications/${id}/read`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (!res.ok) throw new Error("Failed to mark notification as read");
      return res.json();
    },
    onMutate: (id: string) =>
      beginOptimistic((prev) => {
        let decrement = 0;
        const notifications = prev.notifications.map((n) => {
          if (n.id === id && !n.read) {
            decrement = 1;
            return { ...n, read: true };
          }
          return n;
        });
        return { notifications, unreadCount: Math.max(0, prev.unreadCount - decrement) };
      }),
    onError: (_e, _id, ctx) => rollback(ctx),
    onSettled: invalidate
  });

  const markAllReadMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/notifications/read-all", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (!res.ok) throw new Error("Failed to mark all as read");
      return res.json();
    },
    onMutate: () =>
      beginOptimistic((prev) => ({
        notifications: prev.notifications.map((n) => ({ ...n, read: true })),
        unreadCount: 0,
      })),
    onError: (_e, _v, ctx) => rollback(ctx),
    onSuccess: () => {
      // Reconcile the OS app-icon badge with the feed: clearing the feed's unread
      // state should also zero the server badge + OS badge, otherwise the icon
      // badge lingers until the next foreground BadgeClearer pass.
      if (authToken) void clearAppBadgeAndServer(authToken);
    },
    onSettled: invalidate
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/notifications/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (!res.ok) throw new Error("Failed to delete notification");
      return res.json();
    },
    onMutate: (id: string) =>
      beginOptimistic((prev) => {
        const target = prev.notifications.find((n) => n.id === id);
        const decrement = target && !target.read ? 1 : 0;
        return {
          notifications: prev.notifications.filter((n) => n.id !== id),
          unreadCount: Math.max(0, prev.unreadCount - decrement),
        };
      }),
    onError: (_e, _id, ctx) => rollback(ctx),
    onSettled: invalidate
  });

  if (!authToken) return null;

  const notifications = data?.notifications ?? [];
  const unreadCount = data?.unreadCount ?? 0;
  const hasUnread = unreadCount > 0;

  // Filter list based on active tab
  const filteredNotifications = notifications.filter(n => {
    if (activeTab === "all") return true;
    if (activeTab === "weather") return n.category === "weather";
    if (activeTab === "community") return n.category === "community";
    if (activeTab === "system") return n.category === "curation" || n.category === "system";
    return true;
  });

  const handleNotificationClick = (item: InAppNotification) => {
    if (!item.read) {
      markReadMutation.mutate(item.id);
    }
    setIsOpen(false);
    if (item.url) {
      if (item.url.startsWith("/")) {
        // Client-side navigation — NEVER a full reload. A hard navigation here
        // tore down the whole SPA (and any in-progress Beam Agent conversation);
        // routing through React Router keeps that state intact.
        void navigate(item.url);
      } else {
        window.open(item.url, "_blank", "noopener,noreferrer");
      }
    }
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case "weather":
        return <CloudSun className="h-4 w-4" />;
      case "community":
        return <MessageSquare className="h-4 w-4" />;
      case "curation":
      case "system":
        return <Sparkles className="h-4 w-4" />;
      default:
        return <Bell className="h-4 w-4" />;
    }
  };

  const formatTimeAgo = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
      if (seconds < 60) return t("notificationFeed.timeJustNow");
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return t("notificationFeed.timeMinutes", { count: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t("notificationFeed.timeHours", { count: hours });
      const days = Math.floor(hours / 24);
      return t("notificationFeed.timeDays", { count: days });
    } catch {
      return "";
    }
  };

  // Notification item card. The card body is a real <button> (keyboard
  // operable), with the delete control as a sibling button so the two never nest.
  //
  // NOTE: this and the render helpers below are plain functions/JSX values, NOT
  // components declared inside the parent body. Inline component types get a new
  // identity every render, which makes React unmount/remount the whole subtree —
  // and this panel re-renders every 15s poll (`isFetching` flips) and on every
  // optimistic mutation, so scroll position and focus were being destroyed.
  const renderNotificationItem = (item: InAppNotification) => (
    <div
      key={item.id}
      className={`group relative rounded-[12px] border transition-colors duration-300 ${
        item.read
          ? "border-white/6 bg-transparent hover:bg-white/[0.02]"
          : "border-scent-accent/18 bg-white/[0.035] hover:bg-white/[0.05]"
      }`}
    >
      <button
        type="button"
        onClick={() => handleNotificationClick(item)}
        className="flex w-full items-start gap-3 rounded-[12px] p-3 pr-9 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
      >
        <span
          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-black/40 ${
            item.read
              ? "border-white/8 text-scent-text-subtle/60"
              : "border-scent-accent/25 text-scent-accent"
          }`}
        >
          {getCategoryIcon(item.category)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p
              className={`truncate text-[12px] font-semibold leading-tight ${
                item.read ? "text-scent-text-muted" : "text-scent-text-primary"
              }`}
            >
              {item.title}
            </p>
            {!item.read && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-scent-accent" />
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-scent-text-muted/80">
            {item.body}
          </p>
          <span className="mt-1.5 block text-[9px] uppercase tracking-[0.12em] text-scent-text-subtle/65">
            {formatTimeAgo(item.createdAt)}
          </span>
        </div>
      </button>

      {/* Delete: always visible on touch (no hover to reveal it there), reveals on
          hover/focus on pointer devices. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          deleteMutation.mutate(item.id);
        }}
        aria-label={t("notificationFeed.deleteAria")}
        className="absolute right-2 top-2 rounded-full p-1 text-scent-text-subtle/55 opacity-100 transition-opacity duration-200 hover:bg-white/5 hover:text-destructive focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );

  const headerActions = (
    <div className="flex items-center justify-between border-b border-scent-accent/12 pb-3">
      <h3 className="font-serif text-base italic text-scent-text-primary">
        {t("notificationFeed.title")}
      </h3>
      {hasUnread && (
        <button
          type="button"
          onClick={() => markAllReadMutation.mutate()}
          disabled={markAllReadMutation.isPending}
          className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.14em] text-scent-accent/80 transition-colors hover:text-scent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 rounded-sm disabled:opacity-50"
        >
          <CheckCheck size={12} />
          <span>{t("notificationFeed.markAllRead")}</span>
        </button>
      )}
    </div>
  );

  // Loading (first load), error, and empty are distinct states so a slow fetch no
  // longer flashes the "all caught up" empty copy and a failed fetch no longer
  // silently masquerades as empty.
  const renderStatusBlock = ({
    icon,
    title,
    body,
    action,
  }: {
    icon: React.ReactNode;
    title: string;
    body: string;
    action?: React.ReactNode;
  }) => (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <span className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full border border-scent-accent/20 bg-black/40 text-scent-accent/70">
        {icon}
      </span>
      <p className="text-[12px] font-semibold text-scent-text-muted">{title}</p>
      <p className="mt-1 max-w-[14rem] text-[10px] leading-relaxed text-scent-text-subtle/70">
        {body}
      </p>
      {action}
    </div>
  );

  const renderListBody = () => {
    if (isLoading) {
      return renderStatusBlock({
        icon: <LoaderCircle size={20} strokeWidth={1.75} className="animate-spin" />,
        title: t("notificationFeed.loading"),
        body: "",
      });
    }
    if (isError) {
      return renderStatusBlock({
        icon: <WifiOff size={20} strokeWidth={1.75} />,
        title: t("notificationFeed.errorTitle"),
        body: t("notificationFeed.errorBody"),
        action: (
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="mt-3 inline-flex items-center gap-1 rounded-full border border-scent-accent/30 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-scent-accent/85 transition-colors hover:border-scent-accent/60 hover:text-scent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 disabled:opacity-50"
            >
              {isFetching && <LoaderCircle size={11} className="animate-spin" />}
              <span>{t("notificationFeed.retry")}</span>
            </button>
        ),
      });
    }
    if (filteredNotifications.length === 0) {
      return renderStatusBlock({
        icon: <Bell size={20} strokeWidth={1.75} />,
        title:
          activeTab === "all"
            ? t("notificationFeed.emptyAllTitle")
            : t("notificationFeed.emptyFilteredTitle"),
        body:
          activeTab === "all"
            ? t("notificationFeed.emptyAllBody")
            : t("notificationFeed.emptyFilteredBody"),
      });
    }
    return <>{filteredNotifications.map((notification) => renderNotificationItem(notification))}</>;
  };

  const feedContent = (
    <div className="flex h-full flex-col">
      {headerActions}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-3 flex min-h-0 flex-1 flex-col">
        <TabsList className="grid h-8 grid-cols-4 gap-0.5 rounded-full border border-scent-accent/15 bg-black/40 p-0.5">
          {TABS.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className="truncate rounded-full px-1.5 py-1 text-[10px] font-bold uppercase tracking-[0.04em] text-scent-text-subtle transition-colors data-[state=active]:bg-scent-accent/15 data-[state=active]:text-scent-accent data-[state=active]:shadow-none"
            >
              {t(tab.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="scrollbar-thin mt-4 flex-1 space-y-2 overflow-y-auto pr-1.5">
          {renderListBody()}
        </div>
      </Tabs>
    </div>
  );

  const triggerClassName =
    "relative flex h-11 w-11 items-center justify-center rounded-full border border-scent-accent/30 bg-black/35 shadow-[0_0_18px_rgba(0,0,0,0.4)] transition-colors hover:border-scent-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55";

  // Numeric unread badge (was a presence-only dot — 1 and 30 unread looked
  // identical). Caps at 9+ to stay inside the pill on small triggers.
  const unreadBadge = hasUnread ? (
    <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-scent-accent px-1 text-[9px] font-bold leading-none text-[#1a1206] ring-2 ring-[#090604]">
      {unreadCount > 9 ? "9+" : unreadCount}
    </span>
  ) : null;

  const triggerLabel = hasUnread
    ? t("notificationFeed.openUnread", { count: unreadCount })
    : t("notificationFeed.open");

  // Render EXACTLY ONE surface for the active breakpoint. Mounting both (even with
  // CSS `hidden`) opened the Popover and the Drawer's full-screen scrim at the same
  // time because both portal to document.body — that scrim was the unclickable,
  // faded-out second screen. See `useIsDesktop` above.
  if (isDesktop) {
    return (
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button type="button" className={triggerClassName} aria-label={triggerLabel}>
            <Bell size={17} strokeWidth={1.6} className="text-[#f4debd]/85 transition-colors" />
            {unreadBadge}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={10}
          className="h-[28rem] w-[22rem] rounded-[18px] border-scent-accent/20 bg-[#090604]/95 p-4 text-scent-text-primary shadow-[0_22px_60px_rgba(0,0,0,0.7)] backdrop-blur-md"
        >
          {feedContent}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Drawer open={isOpen} onOpenChange={handleOpenChange}>
      <DrawerTrigger asChild>
        <button type="button" className={triggerClassName} aria-label={triggerLabel}>
          <Bell size={17} strokeWidth={1.6} className="text-[#f4debd]/85 transition-colors" />
          {unreadBadge}
        </button>
      </DrawerTrigger>
      <DrawerContent className="flex max-h-[85vh] flex-col border-scent-accent/18 bg-[#090604]/97 px-4 pb-[max(2rem,env(safe-area-inset-bottom))] text-scent-text-primary backdrop-blur-md">
        <div className="flex w-full justify-end pt-2">
          <DrawerClose asChild>
            <button
              type="button"
              aria-label={t("notificationFeed.closeAria")}
              className="rounded-full p-1 text-scent-text-subtle transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
            >
              <X size={16} />
            </button>
          </DrawerClose>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {feedContent}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
