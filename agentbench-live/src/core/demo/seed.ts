import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import type { RunRecord } from "@/core/domain/run";
import { redact } from "@/core/security/redact";

const createdAt = "2026-09-01T09:00:00.000Z";
const completeScore = {
  core: 45,
  reproducible: 20,
  methodology: 15,
  evidence: 15,
  budget: 5,
  total: 100,
};
const syntheticProvenance = {
  kind: "synthetic-demo",
  label: "Synthetic demo — not live verification",
} as const;

export const demoRuns: RunRecord[] = [
  {
    id: "demo-sol-url",
    taskId: "url-shortener",
    taskVersion: "1.0.0",
    agentId: "sol-low",
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
    stage: "completed",
    lastSuccessfulStage: "capturing",
    runPlan: {
      primitives: ["sandbox", "browser"],
      reason: {
        sandbox: "Build and serve the application in an isolated environment.",
        browser: "Exercise the form and confirm the redirect target.",
      },
      verificationStrategy: "Clean build, recorded browser assertions, and desktop capture.",
    },
    score: completeScore,
    evidence: {
      expectedUrl: "https://example.com/agentbench/verification",
      observedUrl: "https://example.com/agentbench/verification",
      browserScreenshot: "/demo/url-shortener-browser.png",
      desktopScreenshot: "/demo/url-shortener-desktop.png",
    },
    sanitizedLogs: [
      "Illustrative build narrative for the synthetic public demo.",
      "Illustrative redirect result; no live session was executed for this seed.",
      "Illustrative desktop artifact generated locally for layout demonstration.",
    ],
    createdAt,
    startedAt: "2026-09-01T09:00:01.000Z",
    completedAt: "2026-09-01T09:03:43.000Z",
    durationMs: 222_000,
    provenance: syntheticProvenance,
  },
  {
    id: "demo-sol-stats",
    taskId: "same-stats-different-graph",
    taskVersion: "1.0.0",
    agentId: "sol-low",
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
    stage: "completed",
    lastSuccessfulStage: "capturing",
    runPlan: {
      primitives: ["sandbox"],
      reason: { sandbox: "Run the deterministic numerical reproduction twice." },
      verificationStrategy: "Compare output hashes, statistics, and geometric error.",
    },
    score: { ...completeScore, core: 40, methodology: 12, total: 92 },
    evidence: {
      deterministicPoints: true,
      expectedStatistics: { meanX: 54.27, meanY: 47.84, varianceX: 280.9, varianceY: 725.23, correlation: -0.07 },
      observedStatistics: { meanX: 54.28, meanY: 47.83, varianceX: 280.88, varianceY: 725.25, correlation: -0.069 },
      circleError: 0.082,
      comparisonPlot: "/demo/same-stats-comparison.png",
    },
    sanitizedLogs: [
      "Illustrative replication narrative; these values are synthetic seed data.",
    ],
    createdAt: "2026-09-01T09:05:00.000Z",
    startedAt: "2026-09-01T09:05:01.000Z",
    completedAt: "2026-09-01T09:07:36.000Z",
    durationMs: 155_000,
    provenance: syntheticProvenance,
  },
  {
    id: "demo-luna-url",
    taskId: "url-shortener",
    taskVersion: "1.0.0",
    agentId: "luna-high",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    stage: "completed",
    lastSuccessfulStage: "capturing",
    runPlan: {
      primitives: ["sandbox", "browser", "desktop"],
      reason: {
        sandbox: "Build from the submitted lockfile.",
        browser: "Verify form behavior and redirect semantics.",
        desktop: "Inspect the canonical GUI presentation.",
      },
      verificationStrategy: "Fresh build plus browser and desktop evidence.",
    },
    score: { ...completeScore, methodology: 13, total: 98 },
    evidence: {
      expectedUrl: "https://example.com/agentbench/verification",
      observedUrl: "https://example.com/agentbench/verification",
      browserScreenshot: "/demo/url-shortener-browser.png",
      desktopScreenshot: "/demo/url-shortener-desktop.png",
    },
    sanitizedLogs: [
      "Illustrative functional result; no live verifier resources were created.",
    ],
    createdAt: "2026-09-01T09:10:00.000Z",
    startedAt: "2026-09-01T09:10:01.000Z",
    completedAt: "2026-09-01T09:13:13.000Z",
    durationMs: 192_000,
    provenance: syntheticProvenance,
  },
  {
    id: "demo-luna-stats",
    taskId: "same-stats-different-graph",
    taskVersion: "1.0.0",
    agentId: "luna-high",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    stage: "failed",
    lastSuccessfulStage: "building",
    failureCode: "verification_failed",
    failureDetail: "Observed correlation exceeded the published tolerance.",
    runPlan: {
      primitives: ["sandbox"],
      reason: { sandbox: "Execute and inspect the numerical reproduction." },
      verificationStrategy: "Recompute statistics from generated points.",
    },
    score: { core: 0, reproducible: 20, methodology: 15, evidence: 15, budget: 5, total: 55 },
    evidence: {
      deterministicPoints: true,
      expectedStatistics: { meanX: 54.27, correlation: -0.07 },
      observedStatistics: { meanX: 54.29, correlation: 0.12 },
      comparisonPlot: "/demo/same-stats-comparison.png",
    },
    sanitizedLogs: [
      "Illustrative deterministic outcome for the synthetic demo.",
      "Illustrative correlation tolerance failure.",
    ],
    createdAt: "2026-09-01T09:15:00.000Z",
    startedAt: "2026-09-01T09:15:01.000Z",
    completedAt: "2026-09-01T09:17:21.000Z",
    durationMs: 140_000,
    provenance: syntheticProvenance,
  },
];

type Color = [number, number, number, number];

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}

function demoPng(kind: "browser" | "desktop" | "comparison"): Buffer {
  const width = 1200;
  const height = 675;
  const pixels = Buffer.alloc(width * height * 4);
  const set = (x: number, y: number, color: Color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = (y * width + x) * 4;
    pixels.set(color, index);
  };
  const rect = (x: number, y: number, w: number, h: number, color: Color) => {
    for (let row = y; row < y + h; row += 1) {
      for (let column = x; column < x + w; column += 1) set(column, row, color);
    }
  };
  const line = (x1: number, y1: number, x2: number, y2: number, color: Color) => {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
    for (let step = 0; step <= steps; step += 1) {
      set(Math.round(x1 + ((x2 - x1) * step) / steps), Math.round(y1 + ((y2 - y1) * step) / steps), color);
    }
  };
  const dark: Color = [11, 13, 12, 255];
  const panel: Color = [22, 27, 23, 255];
  const lineColor: Color = [53, 61, 54, 255];
  const green: Color = [185, 255, 61, 255];
  const ink: Color = [235, 235, 225, 255];
  rect(0, 0, width, height, dark);

  if (kind === "comparison") {
    rect(60, 55, 1080, 565, panel);
    line(600, 80, 600, 590, lineColor);
    for (let side = 0; side < 2; side += 1) {
      const centerX = side === 0 ? 330 : 870;
      line(centerX - 210, 330, centerX + 210, 330, lineColor);
      line(centerX, 120, centerX, 540, lineColor);
      for (let index = 0; index < 120; index += 1) {
        const angle = (index / 120) * Math.PI * 2;
        const wobble = side === 0 ? 0.4 + ((index * 37) % 19) / 22 : 1 + ((index * 17) % 7) / 150;
        const x = centerX + Math.cos(angle) * 155 * wobble;
        const y = 330 + Math.sin(angle) * 205 * wobble;
        rect(Math.round(x) - 2, Math.round(y) - 2, 5, 5, side === 0 ? ink : green);
      }
    }
    rect(120, 90, 150, 7, ink);
    rect(660, 90, 190, 7, green);
  } else {
    rect(45, 40, 1110, 595, panel);
    rect(45, 40, 1110, 50, [28, 34, 29, 255]);
    for (let index = 0; index < 3; index += 1) rect(70 + index * 25, 60, 10, 10, index === 0 ? green : lineColor);
    rect(170, 56, 790, 18, dark);
    rect(100, 135, 1000, 440, [14, 17, 15, 255]);
    rect(155, 185, 270, 13, ink);
    rect(155, 214, 520, 7, lineColor);
    rect(155, 285, 650, 58, panel);
    rect(170, 306, 420, 12, [115, 120, 112, 255]);
    rect(825, 285, 220, 58, green);
    rect(860, 307, 150, 11, dark);
    rect(155, 390, 890, 115, [19, 24, 20, 255]);
    rect(180, 420, 130, 8, green);
    rect(180, 449, 690, 13, ink);
    rect(180, 478, 420, 7, lineColor);
    if (kind === "desktop") {
      rect(0, 630, width, 45, [17, 20, 18, 255]);
      for (let index = 0; index < 7; index += 1) rect(455 + index * 43, 642, 27, 27, index === 2 ? green : lineColor);
    }
  }

  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    scanlines[row] = 0;
    pixels.copy(scanlines, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function exportPublicDemo(
  outputDirectory = resolve("public/demo"),
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const serialized = redact(JSON.stringify(demoRuns, null, 2));
  await Promise.all([
    writeFile(resolve(outputDirectory, "runs.json"), `${serialized}\n`, "utf8"),
    writeFile(resolve(outputDirectory, "url-shortener-browser.png"), demoPng("browser")),
    writeFile(resolve(outputDirectory, "url-shortener-desktop.png"), demoPng("desktop")),
    writeFile(resolve(outputDirectory, "same-stats-comparison.png"), demoPng("comparison")),
  ]);
}
