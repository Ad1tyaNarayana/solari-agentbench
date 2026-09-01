import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { expect, test } from "vitest";
import type { RunPlan } from "@/core/domain/plan";
import type { AgentConfig, RunRecord } from "@/core/domain/run";
import type { SubmissionPackage } from "@/core/security/package-submission";
import type {
  BrowserHandle,
  BrowserPageHandle,
  BrowserService,
  DesktopHandle,
  DesktopService,
  SandboxHandle,
  SandboxProcess,
  SandboxService,
  SolariServices,
} from "@/core/solari/contracts";
import { urlShortenerTask } from "@/core/tasks/url-shortener";
import { UrlShortenerVerifier } from "@/core/verifiers/url-shortener";

test("task contract exposes stable UI selectors without verifier input", () => {
  expect(urlShortenerTask.prompt).toMatch(/#long-url/);
  expect(urlShortenerTask.prompt).toMatch(/#shorten/);
  expect(urlShortenerTask.prompt).toMatch(/#short-url/);
  expect(urlShortenerTask.prompt).not.toContain("agentbench/verification");
});

test("scores an independently observed redirect and captures all three primitives", async () => {
  const services = createUrlShortenerServices();
  const verificationContext = context(fixturePackage("passing"));
  verificationContext.onStage = (stage) => {
    services.state.stages.push(stage);
  };
  const result = await new UrlShortenerVerifier(services, {
    sleep: async () => undefined,
  }).verify(verificationContext);
  expect(result.functional.passed).toBe(true);
  expect(result.score.core).toBe(45);
  expect(result.evidence).toMatchObject({
    browserRecording: expect.any(String),
    browserScreenshot: expect.stringMatching(/^data:image\/png;base64,/),
    desktopScreenshot: expect.stringMatching(/^data:image\/png;base64,/),
  });
  expect(services.state.sandboxKilled).toBe(true);
  expect(services.state.browserClosed).toBe(true);
  expect(services.state.desktopKilled).toBe(true);
  expect(services.state.browserCloseCalls).toBe(1);
  expect(services.state.stages).toEqual([
    "provisioning",
    "building",
    "verifying",
    "capturing",
  ]);
  expect(services.state.sandboxTimeoutMs).toBe(1_234);
});

test("does not award functional points for an observed wrong redirect", async () => {
  const services = createUrlShortenerServices({ wrongRedirect: true });
  const result = await new UrlShortenerVerifier(services, {
    sleep: async () => undefined,
  }).verify(context(fixturePackage("passing")));
  expect(result.functional).toMatchObject({ passed: false });
  expect(result.score.core).toBe(0);
});

test("maps a non-zero clean build to build_failed and still cleans resources", async () => {
  const services = createUrlShortenerServices({ buildFails: true });
  await expect(
    new UrlShortenerVerifier(services, {
      sleep: async () => undefined,
    }).verify(context(fixturePackage("passing"))),
  ).rejects.toMatchObject({ code: "build_failed" });
  expect(services.state.sandboxKilled).toBe(true);
});

function context(submission: SubmissionPackage) {
  const run: RunRecord = {
    id: "run-123",
    taskId: urlShortenerTask.id,
    taskVersion: urlShortenerTask.version,
    agentId: "sol-low",
    stage: "verifying",
    sanitizedLogs: [],
    createdAt: "2026-09-01T00:00:00.000Z",
  };
  const agent: AgentConfig = {
    id: "sol-low",
    label: "Sol · Low",
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
  };
  const plan: RunPlan = {
    primitives: ["sandbox", "browser"],
    reason: { sandbox: "build", browser: "inspect" },
    verificationStrategy: "redirect assertion",
  };
  return {
    run,
    task: urlShortenerTask,
    agent,
    plan,
    submission,
    remainingMs: () => 1_234,
    runWithDeadline: async <T>(_label: string, operation: () => Promise<T>) =>
      operation(),
    acquireWithDeadline: async <T>(
      _label: string,
      operation: () => Promise<T>,
      cleanup: (resource: T) => Promise<void>,
    ) => {
      void cleanup;
      return operation();
    },
    runWithCleanupGrace: async <T>(
      _label: string,
      operation: () => Promise<T>,
    ) => operation(),
    onStage: (stage: string) => {
      void stage;
    },
  };
}

function fixturePackage(kind: "passing" | "failing"): SubmissionPackage {
  const root = resolve(
    `tests/fixtures/url-shortener/${kind}/submission`,
  );
  const entries: SubmissionPackage["entries"] = {};
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = resolve(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else {
        entries[relative(root, path).replaceAll("\\", "/")] = {
          kind: "text",
          contents: readFileSync(path, "utf8"),
        };
      }
    }
  };
  visit(root);
  return { entries, digest: "fixture-digest" };
}

function createUrlShortenerServices(options: {
  wrongRedirect?: boolean;
  buildFails?: boolean;
} = {}): SolariServices & {
  state: {
    sandboxKilled: boolean;
    browserClosed: boolean;
    desktopKilled: boolean;
    browserCloseCalls: number;
    sandboxTimeoutMs?: number;
    stages: string[];
  };
} {
  const state = {
    sandboxKilled: false,
    browserClosed: false,
    desktopKilled: false,
    browserCloseCalls: 0,
    sandboxTimeoutMs: undefined as number | undefined,
    stages: [] as string[],
  };
  let currentUrl = "";
  const previewUrl = "https://preview.getsolari.test";
  const page: BrowserPageHandle = {
    async goto(url) {
      currentUrl = url.includes("/short-1")
        ? options.wrongRedirect
          ? "https://example.com/wrong"
          : "https://example.com/agentbench/verification?nonce=run-123"
        : url;
    },
    async fill() {},
    async click() {},
    async textContent() {
      return "/short-1";
    },
    async waitForUrl() {},
    url: () => currentUrl,
    async screenshot() {
      return new Uint8Array([1, 2, 3]);
    },
  };
  const browserHandle: BrowserHandle = {
    id: "browser-1",
    async newPage() {
      return page;
    },
    async close() {
      state.browserClosed = true;
      state.browserCloseCalls += 1;
    },
  };
  const browser: BrowserService = {
    async create() {
      return browserHandle;
    },
    async listIds() {
      return [];
    },
    async release() {
      state.browserClosed = true;
    },
    async getReplayUrl() {
      return { url: "https://replay.getsolari.test/run", expiresInSeconds: 600 };
    },
  };
  const processHandle: SandboxProcess = {
    async wait() {
      return 0;
    },
    async kill() {},
  };
  const sandboxHandle: SandboxHandle = {
    id: "sandbox-1",
    async exec(command, args = []) {
      const build = command === "npm" && args.includes("build");
      return {
        exitCode: build && options.buildFails ? 1 : 0,
        stdout: "ok",
        stderr: build && options.buildFails ? "build broke" : "",
      };
    },
    async start() {
      return processHandle;
    },
    async mkdir() {},
    async writeFile() {},
    async readFile() {
      return new Uint8Array();
    },
    async previewUrl() {
      return { url: previewUrl };
    },
    async kill() {
      state.sandboxKilled = true;
    },
  };
  const sandbox: SandboxService = {
    async create(options) {
      state.sandboxTimeoutMs = options?.timeoutMs;
      return sandboxHandle;
    },
    async connect() {
      return sandboxHandle;
    },
    async listIds() {
      return [];
    },
    async kill() {
      state.sandboxKilled = true;
    },
  };
  const desktopHandle: DesktopHandle = {
    id: "desktop-1",
    async health() {
      return { ready: true, display: true, vnc: true };
    },
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async open() {
      return 42;
    },
    async type() {},
    async screenshot() {
      return new Uint8Array([4, 5, 6]);
    },
    async kill() {
      state.desktopKilled = true;
    },
  };
  const desktop: DesktopService = {
    async create() {
      return desktopHandle;
    },
    async listIds() {
      return [];
    },
    async kill() {
      state.desktopKilled = true;
    },
  };
  return { browser, sandbox, desktop, state };
}
