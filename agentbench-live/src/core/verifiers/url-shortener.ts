import type { FailureCode } from "@/core/domain/run";
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
  const hasMethodology = Boolean(context.submission.entries["methodology.md"]?.trim());
  const provenance = context.submission.entries["provenance.json"];
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
    const startedAt = Date.now();
    const supervisor = new ResourceSupervisor();
    const logs: string[] = [];
    let sandbox: SandboxHandle | undefined;
    let browser: BrowserHandle | undefined;
    let desktop: DesktopHandle | undefined;
    let server: SandboxProcess | undefined;
    let result: UrlShortenerVerificationResult | undefined;

    try {
      sandbox = await this.services.sandbox.create({ timeoutMs: 300_000 });
      supervisor.trackSandbox(sandbox);
      await uploadTextTree(sandbox, context.submission, "/work/submission");

      await this.requireCommand(
        sandbox,
        "npm",
        ["ci"],
        "/work/submission/source",
      );
      await this.requireCommand(
        sandbox,
        "npm",
        ["run", "build"],
        "/work/submission/source",
      );
      logs.push("Clean install and production build succeeded.");

      server = await sandbox.start(
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
      );
      const preview = await sandbox.previewUrl(3000);

      browser = await this.services.browser.create({
        recording: true,
        stealth: true,
      });
      supervisor.trackBrowser(browser);
      const page = await browser.newPage();
      const expectedUrl = `https://example.com/agentbench/verification?nonce=${encodeURIComponent(context.run.id)}`;
      await page.goto(preview.url);
      await page.fill("#long-url", expectedUrl);
      await page.click("#shorten");
      const shortValue = (await page.textContent("#short-url"))?.trim();
      if (!shortValue) {
        throw new VerificationFailure(
          "verification_failed",
          "The #short-url element did not contain a URL",
        );
      }
      const shortUrl = new URL(shortValue, preview.url).toString();
      await page.goto(shortUrl);
      await page.waitForUrl(expectedUrl, 30_000);
      const observedUrl = page.url();
      const browserScreenshot = pngDataUrl(await page.screenshot());
      await browser.close();
      const browserRecording = await this.pollReplay(browser.id);

      desktop = await this.services.desktop.create({
        timeoutMs: 60_000,
        resolution: "1280x720",
      });
      supervisor.trackDesktop(desktop);
      await this.waitForDesktop(desktop);
      await desktop.open("google-chrome", [preview.url]);
      await this.sleep(1_000);
      const desktopScreenshot = pngDataUrl(await desktop.screenshot());

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
          withinBudget: Date.now() - startedAt <= context.task.budget.totalMs,
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
      };
    } finally {
      if (server) {
        try {
          await server.kill();
        } catch (error) {
          logs.push(
            `Server cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const cleanupIssues = await supervisor.cleanup();
      for (const issue of cleanupIssues) logs.push(issue.detail);
      if (result && cleanupIssues.length > 0) {
        result.evidence.cleanupIssues = cleanupIssues;
      }
    }

    return result as UrlShortenerVerificationResult;
  }

  private async requireCommand(
    sandbox: SandboxHandle,
    command: string,
    args: string[],
    cwd: string,
  ): Promise<void> {
    const execution = await sandbox.exec(command, args, {
      cwd,
      timeoutMs: 120_000,
    });
    if (execution.exitCode !== 0) {
      throw new VerificationFailure(
        "build_failed",
        `${command} ${args.join(" ")} failed: ${execution.stderr}`,
      );
    }
  }

  private async pollReplay(id: string): Promise<string | undefined> {
    for (let attempt = 0; attempt < this.replayAttempts; attempt += 1) {
      try {
        return (await this.services.browser.getReplayUrl(id)).url;
      } catch {
        if (attempt + 1 < this.replayAttempts) await this.sleep(3_000);
      }
    }
    return undefined;
  }

  private async waitForDesktop(desktop: DesktopHandle): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const health = await desktop.health();
      if (health.ready && health.display && health.vnc) return;
      await this.sleep(1_000);
    }
    throw new VerificationFailure(
      "evidence_failed",
      "Desktop did not become ready for canonical evidence",
    );
  }
}
