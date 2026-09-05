"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function RunUpdates({ initialSignature, runId }: { initialSignature: string; runId?: string }) {
  const { refresh } = useRouter();
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let signature = initialSignature;
    let stopped = false;
    let busy = false;
    const controller = new AbortController();
    async function check() {
      if (stopped || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const response = await fetch(runId ? `/api/runs/${encodeURIComponent(runId)}` : "/api/runs", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Updates unavailable");
        const next = JSON.stringify(await response.json());
        if (stopped) return;
        setOffline(false);
        if (next !== signature) { signature = next; refresh(); }
      } catch { if (!stopped) setOffline(true); }
      finally { busy = false; }
    }
    const timer = setInterval(() => void check(), 2500);
    const immediate = () => void check();
    window.addEventListener("focus", immediate);
    window.addEventListener("agentbench:run-created", immediate);
    document.addEventListener("visibilitychange", immediate);
    return () => { stopped = true; controller.abort(); clearInterval(timer); window.removeEventListener("focus", immediate); window.removeEventListener("agentbench:run-created", immediate); document.removeEventListener("visibilitychange", immediate); };
  }, [initialSignature, runId, refresh]);
  return offline ? <p className="retention-note" role="status">Live updates disconnected. Retrying automatically…</p> : null;
}
