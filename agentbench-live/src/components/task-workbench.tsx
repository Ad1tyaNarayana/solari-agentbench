"use client";

import { useState } from "react";
import Link from "next/link";
import type { LibraryTask } from "@/server/task-library";
import { RunLauncher } from "./run-launcher";

const descriptions: Record<string, { category: string; summary: string; mark: string }> = {
  "url-shortener": { category: "Software engineering", summary: "Build a working web app. Test the form, follow a short link, and verify the destination.", mark: "↗" },
  "same-stats-different-graph": { category: "Paper reproduction · Statistics", summary: "Reproduce the Same Stats, Different Graph technique: different shapes with matching summary statistics.", mark: "∿" },
  "raft-safety": { category: "Paper reproduction · Distributed systems", summary: "Implement Raft consensus and check election, replication and safety against deterministic traces.", mark: "⇄" },
};

export function TaskWorkbench({ items }: { items: LibraryTask[] }) {
  const [selected, setSelected] = useState(0);
  const item = items[selected];
  if (!item) return <section className="panel">No tasks discovered. Configure a benchmark pack to get started.</section>;
  return <section id="launch" className="task-workbench">
    <div className="section-heading section-heading--wide"><h2>Tasks</h2><Link className="secondary-link" href="/studio">New benchmark</Link></div>
    <div className="task-library">{items.map((entry, index) => {
      const info = descriptions[entry.task.id] ?? { category: entry.benchmarkName, summary: entry.task.prompt.replace(/^#+\s*/gm, "").slice(0, 160), mark: "◇" };
      return <button type="button" className="task-card" aria-pressed={selected === index} key={`${entry.benchmarkId}/${entry.task.id}`} onClick={() => setSelected(index)}>
        <span className="task-category">{info.category.replace("Paper reproduction · ", "")}</span><strong>{entry.task.title}</strong>
        <span className="task-card__meta">{entry.task.evaluators?.length ?? 0} checks <span>·</span> {entry.task.budget.targetMs ? `${entry.task.budget.targetMs / 60000} min target / ${entry.task.budget.totalMs / 60000} min cap` : `${entry.task.budget.totalMs / 60000} min budget`}</span>
      </button>;
    })}</div>
    <div className="experiment-detail">
      <div className="experiment-title"><h3>{item.task.title}</h3><p>{descriptions[item.task.id]?.summary ?? item.task.prompt.slice(0, 160)}</p><div className="primitive-row"><span className="primitive-label">Allowed resources</span>{item.task.allowedPrimitives.map(p => <span key={p}>{p}</span>)}</div></div>
      <div><h4>Evaluation checks</h4><div className="check-chips">{item.task.evaluators?.map(e => <span key={e.id}>{e.id} <small>{e.weight} pts</small></span>)}</div></div>
      <details><summary>Task prompt</summary><pre>{item.task.prompt}</pre></details>
      <p className="task-policy">{item.task.evaluators?.some(e => e.type === "command" && e.config.network !== true) ? "Requires network-isolated evaluation; runs fail safely if isolation is unavailable." : "Network-enabled evaluation is explicitly allowed by this pack. Only run submissions you trust in this local operator tool."} {item.task.evaluators?.some(e => e.type === "browser") ? "Browser replay availability is verified during evaluation; certification fails if recording cannot be retrieved." : ""} {item.task.budget.targetMs ? "Quality is scored independently. Time-adjusted score = quality × min(1, target / elapsed time), including verification and cleanup but excluding queue time." : ""}</p>
    </div>
    <RunLauncher key={`${item.benchmarkId}/${item.task.id}`} tasks={[item.task]} agents={item.agents} benchmarkId={item.benchmarkId} benchmarkDigest={item.benchmarkDigest} />
  </section>;
}
