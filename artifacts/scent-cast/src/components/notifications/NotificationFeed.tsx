import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import {
  Bell,
  Trash2,
  CheckCheck,
  CloudSun,
  MessageSquare,
  Activity,
  AlertCircle,
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
  DrawerHeader,
  DrawerTitle,
  DrawerClose
} from "@/components/ui/drawer";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent
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

export function NotificationFeed() {
  const { authToken } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<string>("all");
  const [isOpen, setIsOpen] = useState(false);

  // 1. Query: Fetch notifications from API
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
    refetchInterval: 15000 // Poll every 15s to keep feed fresh
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
    if (item.url) {
      // Navigate to URL
      if (item.url.startsWith("/")) {
        window.location.href = item.url;
      } else {
        window.open(item.url, "_blank", "noopener,noreferrer");
      }
    }
    setIsOpen(false);
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case "weather":
        return <CloudSun className="h-4 w-4 text-blue-400" />;
      case "community":
        return <MessageSquare className="h-4 w-4 text-amber-500" />;
      case "curation":
      case "system":
        return <Activity className="h-4 w-4 text-purple-400" />;
      default:
        return <Bell className="h-4 w-4 text-white/50" />;
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

  // Sub-component: Notification Item
  const NotificationItem = ({ item }: { item: InAppNotification }) => (
    <div
      onClick={() => handleNotificationClick(item)}
      className={`group flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition-all duration-300 relative ${
        item.read
          ? "border-neutral-900/60 bg-neutral-950/20 hover:bg-neutral-900/10 text-white/60"
          : "border-neutral-800 bg-neutral-900/20 hover:bg-neutral-900/30 text-white"
      }`}
    >
      <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-neutral-900/80 ${
        item.read ? "border-neutral-800 text-white/30" : "border-neutral-700"
      }`}>
        {getCategoryIcon(item.category)}
      </span>

      <div className="flex-1 min-w-0 pr-6">
        <div className="flex items-center gap-1.5">
          <p className="text-[12px] font-semibold truncate leading-tight">
            {item.title}
          </p>
          {!item.read && (
            <span className="h-1.5 w-1.5 rounded-full bg-scent-accent shrink-0" />
          )}
        </div>
        <p className="mt-1 text-[11px] font-sans leading-relaxed text-white/70 line-clamp-2">
          {item.body}
        </p>
        <span className="mt-1.5 block text-[9px] text-white/40 tracking-wider">
          {formatTimeAgo(item.createdAt)}
        </span>
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          deleteMutation.mutate(item.id);
        }}
        aria-label="Delete notification"
        className="absolute right-2 top-2 p-1 rounded-full text-white/20 hover:text-red-400 hover:bg-white/5 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity duration-200"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );

  const HeaderActions = () => (
    <div className="flex items-center justify-between pb-3 border-b border-neutral-900">
      <h3 className="font-serif italic text-base text-white">Notifications</h3>
      {hasUnread && (
        <button
          type="button"
          onClick={() => markAllReadMutation.mutate()}
          className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.14em] text-scent-accent/80 hover:text-scent-accent transition-colors"
        >
          <CheckCheck size={12} />
          <span>Mark all read</span>
        </button>
      )}
    </div>
  );

  const FeedContent = () => (
    <div className="flex flex-col h-full">
      <HeaderActions />
      
      <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-3 flex-1 flex flex-col min-h-0">
        <TabsList className="grid grid-cols-4 bg-neutral-950 border border-neutral-900 rounded-lg p-0.5 h-8">
          <TabsTrigger value="all" className="text-[10px] tracking-[0.05em] uppercase font-bold py-1 px-2">All</TabsTrigger>
          <TabsTrigger value="weather" className="text-[10px] tracking-[0.05em] uppercase font-bold py-1 px-2">Atm</TabsTrigger>
          <TabsTrigger value="community" className="text-[10px] tracking-[0.05em] uppercase font-bold py-1 px-2">Comm</TabsTrigger>
          <TabsTrigger value="system" className="text-[10px] tracking-[0.05em] uppercase font-bold py-1 px-2">Sys</TabsTrigger>
        </TabsList>

        <div className="mt-4 flex-1 overflow-y-auto space-y-2 pr-1.5 scrollbar-thin">
          {filteredNotifications.length > 0 ? (
            filteredNotifications.map(notification => (
              <NotificationItem key={notification.id} item={notification} />
            ))
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-neutral-900 bg-neutral-950 text-white/20 mb-3">
                <Bell size={20} />
              </span>
              <p className="text-[12px] font-semibold text-white/50">No notifications</p>
              <p className="mt-0.5 text-[10px] text-white/30 font-sans">
                {activeTab === "all"
                  ? "We'll let you know when things happen."
                  : `No notifications in this category.`}
              </p>
            </div>
          )}
        </div>
      </Tabs>
    </div>
  );

  return (
    <>
      {/* Desktop View: Dropdown Popover */}
      <div className="hidden md:block">
        <Popover open={isOpen} onOpenChange={setIsOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="relative flex h-11 w-11 items-center justify-center rounded-full border border-neutral-800 bg-black/45 shadow-[0_0_12px_rgba(0,0,0,0.4)] transition-all hover:border-scent-accent/50 hover:bg-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55"
              aria-label="Open notifications"
            >
              <Bell size={18} className="text-[#f4debd]/85 hover:text-white transition-colors" />
              {hasUnread && (
                <span className="absolute right-2.5 top-2.5 flex h-2 w-2 shrink-0 rounded-full bg-scent-accent animate-pulse" />
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={10}
            className="w-80 h-[28rem] rounded-2xl border-neutral-800 bg-neutral-950/95 p-4 text-[#fff7ec] shadow-[0_20px_50px_rgba(0,0,0,0.85)] backdrop-blur-md"
          >
            <FeedContent />
          </PopoverContent>
        </Popover>
      </div>

      {/* Mobile View: Bottom Drawer */}
      <div className="md:hidden">
        <Drawer open={isOpen} onOpenChange={setIsOpen}>
          <DrawerTrigger asChild>
            <button
              type="button"
              className="relative flex h-11 w-11 items-center justify-center rounded-full border border-neutral-800 bg-black/45 shadow-[0_0_12px_rgba(0,0,0,0.4)] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55"
              aria-label="Open notifications"
            >
              <Bell size={18} className="text-[#f4debd]/85 transition-colors" />
              {hasUnread && (
                <span className="absolute right-2.5 top-2.5 flex h-2 w-2 shrink-0 rounded-full bg-scent-accent animate-pulse" />
              )}
            </button>
          </DrawerTrigger>
          <DrawerContent className="border-neutral-800 bg-neutral-950/95 text-[#fff7ec] px-4 pb-8 max-h-[85vh] flex flex-col backdrop-blur-md">
            <div className="w-full flex justify-end pt-2">
              <DrawerClose asChild>
                <button type="button" className="p-1 rounded-full text-white/40 hover:text-white hover:bg-white/10">
                  <X size={16} />
                </button>
              </DrawerClose>
            </div>
            <div className="flex-1 overflow-hidden min-h-0">
              <FeedContent />
            </div>
          </DrawerContent>
        </Drawer>
      </div>
    </>
  );
}
