const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

export function renderViewer(summary, events) {
  const checks = Object.entries(summary.invariants)
    .map(([name, passed]) => `<li data-testid="invariant-${kebab(name)}" aria-label="${escapeHtml(name)}">${passed ? "PASS" : "FAIL"}</li>`)
    .join("");
  const rows = events.map((event) => `<tr><td>${event.tick}</td><td>${escapeHtml(event.type)}</td><td>${event.term}</td><td>${escapeHtml(event.node)}</td><td>${event.commitIndex}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Raft fault trace</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#18212f}h1{margin-bottom:.25rem}.ok{color:#08783e}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd3dc;padding:.4rem;text-align:left}code{background:#eef2f6;padding:.15rem .3rem}</style></head><body><h1 data-testid="title">Raft fault trace</h1><p>Scenario <strong data-testid="scenario">${escapeHtml(summary.scenario)}</strong></p><p>Term <strong data-testid="term">${summary.finalTerm}</strong> · Leader <strong data-testid="leader">${escapeHtml(summary.finalLeader)}</strong> · Commit index <strong data-testid="commit-index">${summary.commitIndex}</strong></p><p data-testid="partition">${summary.partitionObserved ? "minority partition observed" : "no partition"}</p><ul class="ok">${checks}</ul><h2>Protocol events</h2><table><thead><tr><th>Tick</th><th>Event</th><th>Term</th><th>Node</th><th>Commit</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

function kebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
