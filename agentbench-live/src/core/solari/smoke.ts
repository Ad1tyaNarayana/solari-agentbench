import type { SolariServices } from "./contracts";

export type SmokeReport = {
  sandboxOutput: string;
  browserScreenshotBytes: number;
  browserReplayUrl?: string;
  desktopScreenshotBytes: number;
};

export async function runSolariSmoke(
  services: SolariServices,
): Promise<SmokeReport> {
  const sandbox = await services.sandbox.create({ timeoutMs: 60_000 });
  let sandboxOutput: string;
  try {
    const execution = await sandbox.exec("node", [
      "-e",
      "console.log('agentbench-sandbox-ok')",
    ]);
    if (execution.exitCode !== 0) {
      throw new Error(`Sandbox smoke failed: ${execution.stderr}`);
    }
    sandboxOutput = execution.stdout.trim();
  } finally {
    await sandbox.kill();
  }

  const browser = await services.browser.create({ recording: true });
  let browserScreenshotBytes: number;
  try {
    const page = await browser.newPage();
    await page.goto("https://example.com");
    browserScreenshotBytes = (await page.screenshot()).byteLength;
  } finally {
    await browser.close();
  }
  let browserReplayUrl: string | undefined;
  try {
    browserReplayUrl = (await services.browser.getReplayUrl(browser.id)).url;
  } catch {
    browserReplayUrl = undefined;
  }

  const desktop = await services.desktop.create({
    timeoutMs: 60_000,
    resolution: "1280x720",
  });
  let desktopScreenshotBytes: number;
  try {
    const health = await desktop.health();
    if (!health.ready || !health.display || !health.vnc) {
      throw new Error("Desktop smoke did not become ready");
    }
    desktopScreenshotBytes = (await desktop.screenshot()).byteLength;
  } finally {
    await desktop.kill();
  }

  return {
    sandboxOutput,
    browserScreenshotBytes,
    browserReplayUrl,
    desktopScreenshotBytes,
  };
}
