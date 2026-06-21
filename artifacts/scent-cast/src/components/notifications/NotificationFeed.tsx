import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Bell,
  Trash2,
  CheckCheck,
  CloudSun,
  MessageSquare,
  Sparkles,
  X
} from "lucide-react";

import { useAuth } from "@/context/AuthContext";
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

const TABS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "weather", label: "Weather" },
  { value: "community", label: "Community" },
  { value: "system", label: "Updates" },
];

export function NotificationFeed() {
  const { authToken } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<string>("all");
  const [isOpen, setIsOpen] = useState(false);

  // 1. Query: Fetch notifications from API. Firing is entirely server-driven —
  // there is no client-side notification generation, so React Query's keyed cache
  // is the dedupe boundary (one in-flight request per token, shared across the
  // desktop + mobile triggers below).
  const { data: notifications = [] } = useQuery<InAppNotification[]>({
    queryKey: ["notifications", authToken],
    queryFn: async () => {
      if (!authToken) return [];
      const res = await fetch("/api/notifications", {
        headers: {
          Authorization: `Bearer ${authToken}`
        }
      });
      if (!res.ok) throw new Error("Failed to fetch notifications");
      const json = await res.json();
      return json.notifications || [];
    },
    enabled: !!authToken,
    refetchInterval: 15000, // Poll every 15s to keep feed fresh
    staleTime: 15000, // align freshness window with the poll cadence
    refetchOnWindowFocus: false // the 15s poll already keeps it fresh; avoid focus-storm refetches
  });

  // 2. Mutations
  const markReadMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/notifications/${id}/read`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${authToken}`
        }
      });
      if (!res.ok) throw new Error("Failed to mark notification as read");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    }
  });

  const markAllReadMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/notifications/read-all", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${authToken}`
        }
      });
      if (!res.ok) throw new Error("Failed to mark all as read");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/notifications/${id}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${authToken}`
        }
      });
      if (!res.ok) throw new Error("Failed to delete notification");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    }
  });

  if (!authToken) return null;

  const unreadCount = notifications.filter(n => !n.read).length;
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
        navigate(item.url);
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
      if (seconds < 60) return "Just now";
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    } catch {
      return "";
    }
  };

  // Sub-component: Notification Item. The card body is a real <button> (keyboard
  // operable), with the delete control as a sibling button so the two never nest.
  const NotificationItem = ({ item }: { item: InAppNotification }) => (
    <div
      className={`group relative rounded-[14px] border transition-colors duration-300 ${
        item.read
          ? "border-white/6 bg-transparent hover:bg-white/[0.02]"
          : "border-scent-accent/18 bg-white/[0.035] hover:bg-white/[0.05]"
      }`}
    >
      <button
        type="button"
        onClick={() => handleNotificationClick(item)}
        className="flex w-full items-start gap-3 rounded-[14px] p-3 pr-9 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
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

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          deleteMutation.mutate(item.id);
        }}
        aria-label="Delete notification"
        className="absolute right-2 top-2 rounded-full p-1 text-scent-text-subtle/45 opacity-0 transition-opacity duration-200 hover:bg-white/5 hover:text-[#e7a98f] focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 group-hover:opacity-100"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );

  const HeaderActions = () => (
    <div className="flex items-center justify-between border-b border-scent-accent/12 pb-3">
      <h3 className="font-serif text-base italic text-scent-text-primary">Notifications</h3>
      {hasUnread && (
        <button
          type="button"
          onClick={() => markAllReadMutation.mutate()}
          className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.14em] text-scent-accent/80 transition-colors hover:text-scent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 rounded-sm"
        >
          <CheckCheck size={12} />
          <span>Mark all read</span>
        </button>
      )}
    </div>
  );

  const FeedContent = () => (
    <div className="flex h-full flex-col">
      <HeaderActions />

      <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-3 flex min-h-0 flex-1 flex-col">
        <TabsList className="grid h-8 grid-cols-4 gap-0.5 rounded-full border border-scent-accent/15 bg-black/40 p-0.5">
          {TABS.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className="truncate rounded-full px-1.5 py-1 text-[10px] font-bold uppercase tracking-[0.04em] text-scent-text-subtle transition-colors data-[state=active]:bg-scent-accent/15 data-[state=active]:text-scent-accent data-[state=active]:shadow-none"
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="scrollbar-thin mt-4 flex-1 space-y-2 overflow-y-auto pr-1.5">
          {filteredNotifications.length > 0 ? (
            filteredNotifications.map(notification => (
              <NotificationItem key={notification.id} item={notification} />
            ))
          ) : (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <span className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full border border-scent-accent/20 bg-black/40 text-scent-accent/70">
                <Bell size={20} strokeWidth={1.75} />
              </span>
              <p className="text-[12px] font-semibold text-scent-text-muted">
                {activeTab === "all" ? "You're all caught up" : "Nothing here yet"}
              </p>
              <p className="mt-1 max-w-[14rem] text-[10px] leading-relaxed text-scent-text-subtle/70">
                {activeTab === "all"
                  ? "Weather cues, community replies, and curation updates will appear here."
                  : "No notifications in this category yet."}
              </p>
            </div>
          )}
        </div>
      </Tabs>
    </div>
  );

  const triggerClassName =
    "relative flex h-11 w-11 items-center justify-center rounded-full border border-scent-accent/30 bg-black/35 shadow-[0_0_18px_rgba(0,0,0,0.4)] transition-colors hover:border-scent-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55";

  const unreadBadge = hasUnread ? (
    <span className="absolute right-2.5 top-2.5 flex h-2 w-2 shrink-0 rounded-full bg-scent-accent ring-2 ring-[#0b0805]" />
  ) : null;

  const triggerLabel = hasUnread
    ? `Open notifications, ${unreadCount} unread`
    : "Open notifications";

  return (
    <>
      {/* Desktop View: Dropdown Popover */}
      <div className="hidden md:block">
        <Popover open={isOpen} onOpenChange={setIsOpen}>
          <PopoverTrigger asChild>
            <button type="button" className={triggerClassName} aria-label={triggerLabel}>
              <Bell size={18} className="text-[#f4debd]/85 transition-colors" />
              {unreadBadge}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={10}
            className="h-[28rem] w-[22rem] rounded-[18px] border-scent-accent/20 bg-[#0b0805]/96 p-4 text-scent-text-primary shadow-[0_22px_60px_rgba(0,0,0,0.7)] backdrop-blur-md"
          >
            <FeedContent />
          </PopoverContent>
        </Popover>
      </div>

      {/* Mobile View: Bottom Drawer */}
      <div className="md:hidden">
        <Drawer open={isOpen} onOpenChange={setIsOpen}>
          <DrawerTrigger asChild>
            <button type="button" className={triggerClassName} aria-label={triggerLabel}>
              <Bell size={18} className="text-[#f4debd]/85 transition-colors" />
              {unreadBadge}
            </button>
          </DrawerTrigger>
          <DrawerContent className="flex max-h-[85vh] flex-col border-scent-accent/18 bg-[#0b0805]/97 px-4 pb-8 text-scent-text-primary backdrop-blur-md">
            <div className="flex w-full justify-end pt-2">
              <DrawerClose asChild>
                <button
                  type="button"
                  aria-label="Close notifications"
                  className="rounded-full p-1 text-scent-text-subtle transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
                >
                  <X size={16} />
                </button>
              </DrawerClose>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <FeedContent />
            </div>
          </DrawerContent>
        </Drawer>
      </div>
    </>
  );
}
