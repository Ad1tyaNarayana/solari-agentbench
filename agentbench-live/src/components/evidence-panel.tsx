import Image from "next/image";
import type { RunRecord } from "@/core/domain/run";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function display(value: unknown): string {
  return typeof value === "number" ? value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : String(value ?? "—");
}

function EvidenceImage({ src, alt }: { src: string; alt: string }) {
  return (
    <figure className="evidence-image">
      <Image src={src} alt={alt} width={1200} height={675} unoptimized />
      <figcaption>{alt}</figcaption>
    </figure>
  );
}

export function EvidencePanel({ run }: { run: RunRecord }) {
  const evidence = run.evidence ?? {};
  const expected = record(evidence.expectedStatistics);
  const observed = record(evidence.observedStatistics);
  const metricKeys = Array.from(
    new Set([...Object.keys(expected ?? {}), ...Object.keys(observed ?? {})]),
  );
  const replay = typeof evidence.browserRecording === "string" ? evidence.browserRecording : undefined;
  const browserScreenshot = typeof evidence.browserScreenshot === "string" ? evidence.browserScreenshot : undefined;
  const desktopScreenshot = typeof evidence.desktopScreenshot === "string" ? evidence.desktopScreenshot : undefined;
  const comparisonPlot = typeof evidence.comparisonPlot === "string" ? evidence.comparisonPlot : undefined;

  return (
    <section className="panel evidence-panel" aria-labelledby="evidence-heading">
      <div className="section-heading">
        <p className="eyebrow">Verifier-owned output</p>
        <h2 id="evidence-heading">Evidence</h2>
      </div>

      {metricKeys.length > 0 ? (
        <div className="metrics-table-wrap">
          <table className="metrics-table">
            <thead><tr><th>Metric</th><th>Expected</th><th>Observed</th></tr></thead>
            <tbody>
              {metricKeys.map((key) => (
                <tr key={key}><th scope="row">{key}</th><td>{display(expected?.[key])}</td><td>{display(observed?.[key])}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {replay ? (
        <a className="replay-link" href={replay} target="_blank" rel="noreferrer">
          Open recorded browser replay <span aria-hidden="true">↗</span>
        </a>
      ) : run.taskId === "url-shortener" ? (
        <p className="retention-note">The browser replay is unavailable or has expired. Canonical screenshots remain below.</p>
      ) : null}

      <div className="evidence-grid">
        {browserScreenshot ? <EvidenceImage src={browserScreenshot} alt="Browser evidence screenshot" /> : null}
        {desktopScreenshot ? <EvidenceImage src={desktopScreenshot} alt="Desktop evidence screenshot" /> : null}
        {comparisonPlot ? <EvidenceImage src={comparisonPlot} alt="Expected and observed comparison plot" /> : null}
      </div>

      {run.sanitizedLogs.length > 0 ? (
        <div className="log-block">
          <h3>Sanitized verifier log</h3>
          <pre>{run.sanitizedLogs.join("\n")}</pre>
        </div>
      ) : null}
    </section>
  );
}
