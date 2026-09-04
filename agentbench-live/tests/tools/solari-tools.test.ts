import { describe, expect, it, vi } from "vitest";
import type { RunPlan } from "@/core/domain/plan";
import type { AgentEventKind, AgentEventSink } from "@/core/providers/events";
import type {
  BrowserHandle,
  BrowserPageHandle,
  DesktopHandle,
  SandboxHandle,
  SolariServices,
} from "@/core/solari/contracts";
import { ResourceSupervisor } from "@/core/solari/resource-supervisor";
import { createAgentToolBroker } from "@/core/tools/broker";

function fakeSolari() {
  const page: BrowserPageHandle = {
    goto: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    textContent: vi.fn(async () => "visible text"),
    waitForUrl: vi.fn(async () => undefined),
    url: vi.fn(() => "https://example.test/after"),
    screenshot: vi.fn(async () => Uint8Array.from([137, 80, 78, 71])),
  };
  const browser: BrowserHandle = {
    id: "native-browser-slr_live_must_not_escape",
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  const sandbox: SandboxHandle = {
    id: "native-sandbox-slr_live_must_not_escape",
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
    start: vi.fn(),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => new Uint8Array()),
    previewUrl: vi.fn(async () => ({
      url: "https://preview.test/run",
      token: "slr_live_preview_secret",
    })),
    kill: vi.fn(async () => undefined),
  };
  const desktop: DesktopHandle = {
    id: "native-desktop-slr_live_must_not_escape",
    health: vi.fn(async () => ({ ready: true, display: true, vnc: true })),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "desktop ok", stderr: "" })),
    open: vi.fn(async () => 42),
    type: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Uint8Array.from([137, 80, 78, 71, 1])),
    kill: vi.fn(async () => undefined),
  };
  const services: SolariServices = {
    browser: {
      create: vi.fn(async () => browser),
      listIds: vi.fn(async () => []),
      release: vi.fn(async () => undefined),
      getReplayUrl: vi.fn(async () => ({ url: "", expiresInSeconds: 0 })),
    },
    sandbox: {
      create: vi.fn(async () => sandbox),
      connect: vi.fn(async () => sandbox),
      listIds: vi.fn(async () => []),
      kill: vi.fn(async () => undefined),
    },
    desktop: {
      create: vi.fn(async () => desktop),
      listIds: vi.fn(async () => []),
      kill: vi.fn(async () => undefined),
    },
  };
  return { services, browser, page, sandbox, desktop };
}

function brokerFor(primitives: RunPlan["primitives"]) {
  const fake = fakeSolari();
  const supervisor = new ResourceSupervisor();
  const events: Array<{ kind: AgentEventKind; payload: unknown }> = [];
  const sink: AgentEventSink = {
    emit: async (kind, payload) => {
      events.push({ kind, payload });
    },
    close: () => undefined,
  };
  const broker = createAgentToolBroker({
    workspace: { root: process.cwd(), dispose: async () => undefined },
    plan: {
      primitives,
      reason: Object.fromEntries(
        primitives.map((primitive) => [primitive, `${primitive} is needed`]),
      ),
      verificationStrategy: "capture observations",
    },
    services: fake.services,
    supervisor,
    sink,
    remainingMs: () => 60_000,
    environment: {},
  });
  return { ...fake, supervisor, events, broker };
}

describe("Solari tool policy and lifecycle", () => {
  it("requires the planned primitive on every creation and subsequent operation", async () => {
    const { broker, services } = brokerFor(["sandbox"]);
    const signal = new AbortController().signal;

    await expect(broker.invoke("browser_create", {}, signal)).rejects.toMatchObject({
      code: "primitive_not_planned",
    });
    await expect(
      broker.invoke("browser_goto", { handle: "b-1", url: "https://example.test" }, signal),
    ).rejects.toMatchObject({ code: "primitive_not_planned" });
    await expect(broker.invoke("desktop_create", {}, signal)).rejects.toMatchObject({
      code: "primitive_not_planned",
    });
    await expect(
      broker.invoke("desktop_type", { handle: "d-1", text: "hello" }, signal),
    ).rejects.toMatchObject({ code: "primitive_not_planned" });
    expect(services.browser.create).not.toHaveBeenCalled();
    expect(services.desktop.create).not.toHaveBeenCalled();
  });

  it("denies sandbox creation and operations when sandbox was not planned", async () => {
    const { broker, services } = brokerFor(["browser"]);
    const signal = new AbortController().signal;

    await expect(broker.invoke("sandbox_create", {}, signal)).rejects.toMatchObject({
      code: "primitive_not_planned",
    });
    await expect(
      broker.invoke(
        "sandbox_exec",
        { handle: "s-1", command: "node", args: [] },
        signal,
      ),
    ).rejects.toMatchObject({ code: "primitive_not_planned" });
    expect(services.sandbox.create).not.toHaveBeenCalled();
  });

  it("uses opaque run-local sandbox handles, emits observations, and withholds preview tokens", async () => {
    const { broker, sandbox, supervisor, events } = brokerFor(["sandbox"]);
    const signal = new AbortController().signal;
    try {
      const created = await broker.invoke("sandbox_create", { timeoutMs: 100_000 }, signal);
      expect(created).toEqual({ handle: "s-1" });
      expect(JSON.stringify(created)).not.toMatch(/native-sandbox|slr_live/);

      expect(
        await broker.invoke(
          "sandbox_exec",
          { handle: "s-1", command: "node", args: ["--version"], timeoutMs: 100_000 },
          signal,
        ),
      ).toEqual({ exitCode: 0, stdout: "ok", stderr: "", outputTruncated: false });
      expect(sandbox.exec).toHaveBeenCalledWith("node", ["--version"], {
        timeoutMs: 60_000,
      });
      expect(
        await broker.invoke("sandbox_preview", { handle: "s-1", port: 3000 }, signal),
      ).toEqual({ url: "https://preview.test/run" });
      expect(JSON.stringify(events)).not.toMatch(/native-sandbox|preview_secret|slr_live/);
      expect(events.map(({ kind }) => kind)).toEqual([
        "resource-created",
        "resource-observation",
        "resource-observation",
      ]);
    } finally {
      await supervisor.cleanup();
    }
    expect(sandbox.kill).toHaveBeenCalledOnce();
  });

  it("captures browser and desktop screenshots as evidence candidates", async () => {
    const { broker, browser, desktop, supervisor, events } = brokerFor([
      "browser",
      "desktop",
    ]);
    const signal = new AbortController().signal;
    try {
      await expect(broker.invoke("browser_create", { recording: true }, signal)).resolves.toEqual({
        handle: "b-1",
      });
      await broker.invoke(
        "browser_goto",
        { handle: "b-1", url: "https://example.test" },
        signal,
      );
      await broker.invoke(
        "browser_fill",
        { handle: "b-1", selector: "input", value: "private form value" },
        signal,
      );
      await broker.invoke(
        "browser_click",
        { handle: "b-1", selector: "button" },
        signal,
      );
      await expect(
        broker.invoke("browser_text", { handle: "b-1", selector: "main" }, signal),
      ).resolves.toEqual({ text: "visible text", url: "https://example.test/after" });
      await expect(
        broker.invoke("browser_screenshot", { handle: "b-1" }, signal),
      ).resolves.toEqual({ mediaType: "image/png", dataBase64: "iVBORw==" });

      await expect(broker.invoke("desktop_create", { resolution: "1280x720" }, signal)).resolves.toEqual({
        handle: "d-1",
      });
      await expect(
        broker.invoke(
          "desktop_exec",
          { handle: "d-1", command: "node", args: ["--version"] },
          signal,
        ),
      ).resolves.toEqual({
        exitCode: 0,
        stdout: "desktop ok",
        stderr: "",
        outputTruncated: false,
      });
      await broker.invoke(
        "desktop_open",
        { handle: "d-1", application: "chrome", args: ["https://example.test"] },
        signal,
      );
      await broker.invoke("desktop_type", { handle: "d-1", text: "hello" }, signal);
      await expect(
        broker.invoke("desktop_screenshot", { handle: "d-1" }, signal),
      ).resolves.toEqual({ mediaType: "image/png", dataBase64: "iVBORwE=" });

      const screenshotEvents = events.filter(
        ({ kind, payload }) =>
          kind === "resource-observation" &&
          typeof payload === "object" &&
          payload !== null &&
          "evidenceCandidate" in payload,
      );
      expect(screenshotEvents).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            primitive: "browser",
            handle: "b-1",
            evidenceCandidate: { mediaType: "image/png", dataBase64: "iVBORw==" },
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            primitive: "desktop",
            handle: "d-1",
            evidenceCandidate: { mediaType: "image/png", dataBase64: "iVBORwE=" },
          }),
        }),
      ]);
      expect(JSON.stringify(events)).not.toMatch(/native-(browser|desktop)|slr_live/);
      expect(JSON.stringify(events)).not.toContain("private form value");
    } finally {
      await supervisor.cleanup();
    }
    expect(browser.close).toHaveBeenCalledOnce();
    expect(desktop.kill).toHaveBeenCalledOnce();
  });

  it("registers a created resource before later event publication can fail", async () => {
    const { services, sandbox } = fakeSolari();
    const supervisor = new ResourceSupervisor();
    const broker = createAgentToolBroker({
      workspace: { root: process.cwd(), dispose: async () => undefined },
      plan: {
        primitives: ["sandbox"],
        reason: { sandbox: "run isolated commands" },
        verificationStrategy: "inspect output",
      },
      services,
      supervisor,
      sink: {
        emit: async () => {
          throw new Error("event persistence failed");
        },
        close: () => undefined,
      },
      remainingMs: () => 60_000,
      environment: {},
    });

    try {
      await expect(
        broker.invoke("sandbox_create", {}, new AbortController().signal),
      ).rejects.toThrow("event persistence failed");
    } finally {
      await supervisor.cleanup();
    }
    expect(sandbox.kill).toHaveBeenCalledOnce();
  });

  it("registers a resource that finishes creating after cancellation", async () => {
    const fake = fakeSolari();
    let finishCreate!: (resource: SandboxHandle) => void;
    fake.services.sandbox.create = vi.fn(
      () => new Promise<SandboxHandle>((resolve) => {
        finishCreate = resolve;
      }),
    );
    const supervisor = new ResourceSupervisor();
    const controller = new AbortController();
    const broker = createAgentToolBroker({
      workspace: { root: process.cwd(), dispose: async () => undefined },
      plan: {
        primitives: ["sandbox"],
        reason: { sandbox: "run isolated commands" },
        verificationStrategy: "inspect output",
      },
      services: fake.services,
      supervisor,
      sink: { emit: async () => undefined, close: () => undefined },
      remainingMs: () => 60_000,
      environment: {},
    });

    const creation = broker.invoke("sandbox_create", {}, controller.signal);
    controller.abort(new Error("run cancelled"));
    finishCreate(fake.sandbox);
    try {
      await expect(creation).rejects.toThrow();
    } finally {
      await supervisor.cleanup();
    }
    expect(fake.sandbox.kill).toHaveBeenCalledOnce();
  });

  it("rejects cross-run and unknown handles with a typed error", async () => {
    const first = brokerFor(["browser"]);
    const second = brokerFor(["browser"]);
    const signal = new AbortController().signal;
    try {
      await first.broker.invoke("browser_create", {}, signal);
      await expect(
        second.broker.invoke(
          "browser_goto",
          { handle: "b-1", url: "https://example.test" },
          signal,
        ),
      ).rejects.toMatchObject({ code: "unknown_handle", toolName: "browser_goto" });
    } finally {
      await first.supervisor.cleanup();
      await second.supervisor.cleanup();
    }
  });
});
