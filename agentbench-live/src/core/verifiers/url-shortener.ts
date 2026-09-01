import type { CleanupIssue, FailureCode } from "@/core/domain/run";
import type {
  VerificationContext,
  VerificationResult,
} from "@/core/runner/contracts";
import { computeScore } from "@/core/runner/scoring";
import type {
  BrowserHandle,
  DesktopHandle,
  SandboxHandle,
  SandboxProcess,
  SolariServices,
} from "@/core/solari/contracts";
import { ResourceSupervisor } from "@/core/solari/resource-supervisor";
import { uploadTextTree } from "@/core/solari/upload-tree";
import { submissionText } from "@/core/security/package-submission";

export class VerificationFailure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = "VerificationFailure";
  }
}

export type UrlShortenerVerificationResult = VerificationResult & {
  functional: {
    passed: boolean;
    expectedUrl: string;
    observedUrl: string;
  };
};

type VerifierOptions = {
  sleep?: (milliseconds: number) => Promise<void>;
  replayAttempts?: number;
};

function pngDataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

function methodologicalFidelity(context: VerificationContext): number {
  const hasMethodology = Boolean(
    submissionText(context.submission, "methodology.md")?.trim(),
  );
  const provenance = submissionText(context.submission, "provenance.json");
  if (!hasMethodology || !provenance) return 0;
  try {
    JSON.parse(provenance);
    return 15;
  } catch {
    return 0;
  }
}

export class UrlShortenerVerifier {
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly replayAttempts: number;

  constructor(
    private readonly services: SolariServices,
    options: VerifierOptions = {},
  ) {
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.replayAttempts = options.replayAttempts ?? 10;
  }

  async verify(
    context: VerificationContext,
  ): Promise<UrlShortenerVerificationResult> {
    const supervisor = new ResourceSupervisor();
    const logs: string[] = [];
    let sandbox: SandboxHandle | undefined;
    let browser: BrowserHandle | undefined;
    let desktop: DesktopHandle | undefined;
    let server: SandboxProcess | undefined;
    let result: UrlShortenerVerificationResult | undefined;
    const cleanupIssues: CleanupIssue[] = [];

    try {
      context.onStage("provisioning");
      sandbox = await context.acquireWithDeadline(
        "sandbox provisioning",
        () => this.services.sandbox.create({
          timeoutMs: Math.min(300_000, context.remainingMs()),
        }),
        (lateSandbox) => lateSandbox.kill(),
      );
      supervisor.trackSandbox(sandbox);
      context.onStage("building");
      await context.runWithDeadline("submission upload", () =>
        uploadTextTree(sandbox!, context.submission, "/work/submission"),
      );

      await this.requireCommand(
        context,
        sandbox,
        "npm",
        ["ci"],
        "/work/submission/source",
      );
      await this.requireCommand(
        context,
        sandbox,
        "npm",
        ["run", "build"],
        "/work/submission/source",
      );
      logs.push("Clean install and production build succeeded.");

      server = await context.runWithDeadline("application start", () =>
        sandbox!.start(
          "npm",
          [
            "start",
            "--",
            "--hostname",
            "0.0.0.0",
            "--port",
            "3000",
          ],
          { cwd: "/work/submission/source" },
        ),
      );
      const preview = await context.runWithDeadline("preview URL", () =>
        sandbox!.previewUrl(3000),
      );

      context.onStage("verifying");
      browser = await context.acquireWithDeadline(
        "browser provisioning",
        () => this.services.browser.create({
          recording: true,
          stealth: true,
        }),
        (lateBrowser) => lateBrowser.close(),
      );
      supervisor.trackBrowser(browser);
      const page = await context.runWithDeadline("browser page", () =>
        browser!.newPage(),
      );
      const expectedUrl = `https://example.com/agentbench/verification?nonce=${encodeURIComponent(context.run.id)}`;
      await context.runWithDeadline("browser navigation", () => page.goto(preview.url));
      await context.runWithDeadline("URL input", () =>
        page.fill("#long-url", expectedUrl),
      );
      await context.runWithDeadline("shorten action", () => page.click("#shorten"));
      const shortValue = (
        await context.runWithDeadline("short URL observation", () =>
          page.textContent("#short-url"),
        )
      )?.trim();
      if (!shortValue) {
        throw new VerificationFailure(
          "verification_failed",
          "The #short-url element did not contain a URL",
        );
      }
      const shortUrl = new URL(shortValue, preview.url).toString();
      await context.runWithDeadline("short URL navigation", () => page.goto(shortUrl));
      await context.runWithDeadline("redirect assertion", () =>
        page.waitForUrl(expectedUrl, Math.min(30_000, context.remainingMs())),
      );
      const observedUrl = page.url();
      context.onStage("capturing");
      const browserScreenshot = pngDataUrl(
        await context.runWithDeadline("browser screenshot", () => page.screenshot()),
      );
      const closeIssue = await supervisor.closeBrowser(browser.id);
      if (closeIssue) cleanupIssues.push(closeIssue);
      const browserRecording = await this.pollReplay(context, browser.id);

      desktop = await context.acquireWithDeadline(
        "desktop provisioning",
        () => this.services.desktop.create({
          timeoutMs: Math.min(60_000, context.remainingMs()),
          resolution: "1280x720",
        }),
        (lateDesktop) => lateDesktop.kill(),
      );
      supervisor.trackDesktop(desktop);
      await this.waitForDesktop(context, desktop);
      await context.runWithDeadline("desktop browser launch", () =>
        desktop!.open("google-chrome", [preview.url]),
      );
      await context.runWithDeadline("desktop rendering", () => this.sleep(1_000));
      const desktopScreenshot = pngDataUrl(
        await context.runWithDeadline("desktop screenshot", () =>
          desktop!.screenshot(),
        ),
      );

      const passed = observedUrl === expectedUrl;
      const evidenceCount = [
        browserRecording,
        browserScreenshot,
        desktopScreenshot,
      ].filter(Boolean).length;
      result = {
        functional: { passed, expectedUrl, observedUrl },
        score: computeScore({
          core: passed ? 45 : 0,
          reproducible: true,
          methodology: methodologicalFidelity(context),
          evidence: (evidenceCount / 3) * 15,
          withinBudget: true,
        }),
        evidence: {
          sandboxVerified: true,
          browserRecording,
          browserScreenshot,
          desktopScreenshot,
          expectedUrl,
          observedUrl,
        },
        logs,
        cleanupIssues,
      };
    } finally {
      if (server) {
        try {
          await context.runWithCleanupGrace("server process cleanup", () =>
            server!.kill(),
          );
        } catch (error) {
          cleanupIssues.push({
            code: "cleanup_failed",
            detail: `server process: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      try {
        cleanupIssues.push(...(await context.runWithCleanupGrace(
          "verifier resource cleanup",
          () => supervisor.cleanup(),
        )));
      } catch (error) {
        cleanupIssues.push({
          code: "cleanup_failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      for (const issue of cleanupIssues) logs.push(issue.detail);
      if (result) result.cleanupIssues = cleanupIssues;
    }

    return result as UrlShortenerVerificationResult;
  }

  private async requireCommand(
    context: VerificationContext,
    sandbox: SandboxHandle,
    command: string,
    args: string[],
    cwd: string,
  ): Promise<void> {
    const execution = await context.runWithDeadline(`${command} ${args.join(" ")}`, () =>
      sandbox.exec(command, args, {
        cwd,
        timeoutMs: Math.min(120_000, context.remainingMs()),
      }),
    );
    if (execution.exitCode !== 0) {
      throw new VerificationFailure(
        "build_failed",
        `${command} ${args.join(" ")} failed: ${execution.stderr}`,
      );
    }
  }

  private async pollReplay(
    context: VerificationContext,
    id: string,
  ): Promise<string | undefined> {
    for (let attempt = 0; attempt < this.replayAttempts; attempt += 1) {
      try {
        return (
          await context.runWithDeadline("browser replay", () =>
            this.services.browser.getReplayUrl(id),
          )
        ).url;
      } catch {
        if (attempt + 1 < this.replayAttempts) {
          await context.runWithDeadline("browser replay retry", () =>
            this.sleep(Math.min(3_000, context.remainingMs())),
          );
        }
      }
    }
    return undefined;
  }

  private async waitForDesktop(
    context: VerificationContext,
    desktop: DesktopHandle,
  ): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const health = await context.runWithDeadline("desktop health", () =>
        desktop.health(),
      );
      if (health.ready && health.display && health.vnc) return;
      await context.runWithDeadline("desktop health retry", () =>
        this.sleep(Math.min(1_000, context.remainingMs())),
      );
    }
    throw new VerificationFailure(
      "evidence_failed",
      "Desktop did not become ready for canonical evidence",
    );
  }
}
