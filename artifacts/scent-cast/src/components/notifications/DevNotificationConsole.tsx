import React, { useState } from "react";
import { Terminal, Send, X, AlertTriangle } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

interface Preset {
  name: string;
  category: "weather" | "community" | "curation" | "system";
  title: string;
  body: string;
  url: string | null;
}

const PRESETS: Preset[] = [
  {
    name: "Weather: Cooler & Woody",
    category: "weather",
    title: "Atmosphere Alert",
    body: "Temperature dropped to 62°F. Woody, enveloping profiles are highly recommended.",
    url: "/?intent=weekly"
  },
  {
    name: "Community: Battle Reply",
    category: "community",
    title: "New Reply in Arena",
    body: "Sarah replied to your battle prediction: 'Totally agree, the amber notes win!'",
    url: "/arena"
  },
  {
    name: "Curation: Completed",
    category: "curation",
    title: "Curation Complete",
    body: "Enrichment complete for 'Bleu de Chanel'. Tap to add to your vault.",
    url: "/?curation=mock-job-key"
  },
  {
    name: "System: App Update",
    category: "system",
    title: "ScentBeam Upgraded",
    body: "We've added database-persisted notifications and PWA shortcuts. Try them now!",
    url: "/"
  }
];

export function DevNotificationConsole() {
  const { authToken } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [customTitle, setCustomTitle] = useState("");
  const [customBody, setCustomBody] = useState("");
  const [customCategory, setCustomCategory] = useState<Preset["category"]>("system");
  const [customUrl, setCustomUrl] = useState("");
  const [statusMsg, setStatusMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Dev mode only
  if (!import.meta.env.DEV) return null;
  if (!authToken) return null;

  const handleDispatch = async (preset: Preset) => {
    setLoading(true);
    setStatusMsg(null);
    try {
      const res = await fetch("/api/push/mock", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          title: preset.title,
          body: preset.body,
          category: preset.category,
          url: preset.url
        })
      });

      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }

      setStatusMsg({ type: "success", text: `Dispatched: ${preset.name}` });
    } catch (err: any) {
      setStatusMsg({ type: "error", text: err.message || "Failed to dispatch" });
    } finally {
      setLoading(false);
    }
  };

  const handleCustomDispatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customTitle || !customBody) return;
    setLoading(true);
    setStatusMsg(null);
    try {
      const res = await fetch("/api/push/mock", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          title: customTitle,
          body: customBody,
          category: customCategory,
          url: customUrl || null
        })
      });

      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }

      setStatusMsg({ type: "success", text: "Dispatched custom notification!" });
      setCustomTitle("");
      setCustomBody("");
      setCustomUrl("");
    } catch (err: any) {
      setStatusMsg({ type: "error", text: err.message || "Failed to dispatch" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed bottom-4 left-4 z-[9999] font-sans">
      {isOpen ? (
        <div className="w-80 rounded-2xl border border-neutral-800 bg-neutral-950/95 p-4 text-white shadow-2xl backdrop-blur-md">
          <div className="flex items-center justify-between pb-2 border-b border-neutral-900 mb-3">
            <div className="flex items-center gap-1.5 text-scent-accent font-mono text-[11px] font-bold uppercase tracking-wider">
              <Terminal size={14} />
              <span>Dev Push Console</span>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="text-white/40 hover:text-white"
            >
              <X size={15} />
            </button>
          </div>

          {statusMsg && (
            <div className={`mb-3 p-2.5 rounded-lg border text-[11px] ${
              statusMsg.type === "success"
                ? "bg-green-950/20 border-green-900 text-green-300"
                : "bg-red-950/20 border-red-900 text-red-300"
            }`}>
              {statusMsg.text}
            </div>
          )}

          <div className="space-y-4">
            {/* Presets section */}
            <div>
              <p className="text-[10px] uppercase font-bold text-white/40 tracking-wider mb-2">Simulate Presets</p>
              <div className="grid grid-cols-1 gap-1.5">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    disabled={loading}
                    onClick={() => handleDispatch(preset)}
                    className="w-full flex items-center justify-between text-left px-3 py-2 rounded-lg border border-neutral-900 bg-neutral-900/30 text-[11px] hover:bg-neutral-900 hover:border-neutral-800 transition-colors disabled:opacity-50"
                  >
                    <span>{preset.name}</span>
                    <Send size={11} className="text-white/45 group-hover:text-white" />
                  </button>
                ))}
              </div>
            </div>

            {/* Custom dispatch section */}
            <form onSubmit={handleCustomDispatch} className="border-t border-neutral-900 pt-3 space-y-2.5">
              <p className="text-[10px] uppercase font-bold text-white/40 tracking-wider">Custom Alert</p>
              
              <div>
                <input
                  type="text"
                  placeholder="Title"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  className="w-full bg-neutral-950 border border-neutral-850 px-2.5 py-1.5 rounded-lg text-[11px] placeholder:text-white/30 focus:border-scent-accent outline-none"
                  required
                />
              </div>

              <div>
                <textarea
                  placeholder="Body text..."
                  value={customBody}
                  onChange={(e) => setCustomBody(e.target.value)}
                  className="w-full bg-neutral-950 border border-neutral-850 px-2.5 py-1.5 rounded-lg text-[11px] placeholder:text-white/30 focus:border-scent-accent outline-none min-h-[50px] resize-none"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <select
                  value={customCategory}
                  onChange={(e) => setCustomCategory(e.target.value as Preset["category"])}
                  className="bg-neutral-950 border border-neutral-850 px-2 py-1.5 rounded-lg text-[11px] outline-none"
                >
                  <option value="system">System</option>
                  <option value="weather">Weather</option>
                  <option value="community">Community</option>
                  <option value="curation">Curation</option>
                </select>
                <input
                  type="text"
                  placeholder="URL (e.g. /arena)"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  className="bg-neutral-950 border border-neutral-850 px-2.5 py-1.5 rounded-lg text-[11px] placeholder:text-white/30 focus:border-scent-accent outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={loading || !customTitle || !customBody}
                className="w-full py-2 bg-scent-accent text-black font-semibold text-[11px] uppercase tracking-wider rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                Send Custom Push
              </button>
            </form>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-neutral-850 bg-neutral-950/80 text-white/50 hover:text-scent-accent hover:border-scent-accent/50 shadow-lg transition-all backdrop-blur-sm"
          title="Open Developer Push Console"
        >
          <Terminal size={15} />
        </button>
      )}
    </div>
  );
}
