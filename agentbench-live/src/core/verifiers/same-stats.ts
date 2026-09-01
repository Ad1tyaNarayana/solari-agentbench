import type { FailureCode } from "@/core/domain/run";
import type {
  VerificationContext,
  VerificationResult,
} from "@/core/runner/contracts";
import { computeScore } from "@/core/runner/scoring";
import type { SandboxHandle, SandboxService } from "@/core/solari/contracts";
import { ResourceSupervisor } from "@/core/solari/resource-supervisor";
import { uploadTextTree } from "@/core/solari/upload-tree";
import {
  sameStatsExpected,
  sameStatsSeedCsv,
  sameStatsTarget,
} from "@/core/tasks/same-stats";
import {
  circleError,
  summaryStats,
  withinStatsTolerance,
  type Point,
} from "./geometry";

export class SameStatsVerificationFailure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = "SameStatsVerificationFailure";
  }
}

export type SameStatsVerificationResult = VerificationResult & {
  findings: {
    statisticsPassed: boolean;
    shapePassed: boolean;
    reproducible: boolean;
    observed: ReturnType<typeof summaryStats>;
    expected: typeof sameStatsExpected;
    circleError: number;
  };
};

const outputOne = "/work/output-1";
const outputTwo = "/work/output-2";

function parsePoints(value: string): Point[] {
  const lines = value.trim().split(/\r?\n/);
  if (lines[0]?.trim().toLowerCase() !== "x,y") {
    throw new SameStatsVerificationFailure(
      "verification_failed",
      "points.csv must begin with x,y",
    );
  }
  return lines.slice(1).map((line, index) => {
    const [x, y, ...extra] = line.split(",");
    const point = { x: Number(x), y: Number(y) };
    if (extra.length > 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new SameStatsVerificationFailure(
        "verification_failed",
        `Invalid point on CSV row ${index + 2}`,
      );
    }
    return point;
  });
}

function hasMethodologyHeadings(value: string | undefined): boolean {
  if (!value) return false;
  return ["seed", "objective function", "temperature schedule", "acceptance rule"].every(
    (heading) => new RegExp(`^#+\\s*${heading}\\s*$`, "im").test(value),
  );
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return bytes.length > signature.length && signature.every((value, index) => bytes[index] === value);
}

export class SameStatsVerifier {
  constructor(private readonly services: { sandbox: SandboxService }) {}

  async verify(context: VerificationContext): Promise<SameStatsVerificationResult> {
    const startedAt = Date.now();
    const supervisor = new ResourceSupervisor();
    const logs: string[] = [];
    let result: SameStatsVerificationResult | undefined;

    try {
      const sandbox = await this.services.sandbox.create({
        timeoutMs: context.task.budget.sandboxMs,
      });
      supervisor.trackSandbox(sandbox);
      await uploadTextTree(sandbox, context.submission, "/work/submission");
      await sandbox.writeFile("/work/seed.csv", sameStatsSeedCsv);

      await this.requireCommand(sandbox, "python3", [
        "-m",
        "pip",
        "install",
        "-r",
        "requirements.txt",
      ]);
      await this.runReplication(sandbox, outputOne);
      await this.runReplication(sandbox, outputTwo);

      const [firstPoints, secondPoints, rawResults, comparison] = await Promise.all([
        sandbox.readFile(`${outputOne}/points.csv`),
        sandbox.readFile(`${outputTwo}/points.csv`),
        sandbox.readFile(`${outputOne}/results.json`),
        sandbox.readFile(`${outputOne}/comparison.png`),
      ]);
      try {
        JSON.parse(Buffer.from(rawResults).toString("utf8"));
      } catch {
        throw new SameStatsVerificationFailure(
          "verification_failed",
          "Generated results.json is not valid JSON",
        );
      }

      const reproducible = Buffer.from(firstPoints).equals(Buffer.from(secondPoints));
      const points = parsePoints(Buffer.from(firstPoints).toString("utf8"));
      const observed = summaryStats(points);
      const statisticsPassed = withinStatsTolerance(
        observed,
        sameStatsExpected,
        0.05,
      );
      const shapeError = circleError(points, sameStatsTarget);
      const shapePassed = shapeError < 0.35;
      const pngPassed = isPng(comparison);
      const methodologyPassed = hasMethodologyHeadings(
        context.submission.entries["methodology.md"],
      );
      const functionalPassed = statisticsPassed && shapePassed;

      result = {
        findings: {
          statisticsPassed,
          shapePassed,
          reproducible,
          observed,
          expected: sameStatsExpected,
          circleError: shapeError,
        },
        score: computeScore({
          core: functionalPassed ? 45 : 0,
          reproducible,
          methodology: methodologyPassed ? 15 : 0,
          evidence: pngPassed ? 15 : 0,
          withinBudget: Date.now() - startedAt <= context.task.budget.totalMs,
        }),
        evidence: {
          sandboxVerified: true,
          deterministicPoints: reproducible,
          expectedStatistics: sameStatsExpected,
          observedStatistics: observed,
          circleError: shapeError,
          comparisonPlot: pngPassed
            ? `data:image/png;base64,${Buffer.from(comparison).toString("base64")}`
            : undefined,
        },
        logs: [
          ...logs,
          "Executed the exact replication CLI twice in separate directories.",
        ],
      };
    } finally {
      const cleanupIssues = await supervisor.cleanup();
      for (const issue of cleanupIssues) logs.push(issue.detail);
      if (result && cleanupIssues.length > 0) {
        result.evidence.cleanupIssues = cleanupIssues;
      }
    }

    return result as SameStatsVerificationResult;
  }

  private async requireCommand(
    sandbox: SandboxHandle,
    command: string,
    args: string[],
  ): Promise<void> {
    const execution = await sandbox.exec(command, args, {
      cwd: "/work/submission/source",
      timeoutMs: 120_000,
    });
    if (execution.exitCode !== 0) {
      throw new SameStatsVerificationFailure(
        "build_failed",
        `${command} ${args.join(" ")} failed: ${execution.stderr}`,
      );
    }
  }

  private async runReplication(
    sandbox: SandboxHandle,
    output: string,
  ): Promise<void> {
    await this.requireCommand(sandbox, "python3", [
      "reproduce.py",
      "--input",
      "/work/seed.csv",
      "--output",
      output,
      "--target",
      "circle",
      "--seed",
      "1729",
    ]);
  }
}
