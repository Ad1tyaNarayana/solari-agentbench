import { describe, expect, it, vi } from "vitest";
import { registerCredentialValue } from "@/core/credentials/redaction";
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
import { AgentToolError } from "@/core/tools/types";

function collectLoggableErrorText(value: unknown): string {
  const strings: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (item: unknown) => {
    if (typeof item === "string") {
      strings.push(item);
      return;
    }
    if (item === null || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    if (item instanceof Error) {
      strings.push(item.name, item.message, item.stack ?? "");
    }
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (descriptor !== undefined && "value" in descriptor) visit(descriptor.value);
    }
  };
  visit(value);
  return strings.join("\n");
}

function fakeSolari() {
  const page: BrowserPageHandle = {
    goto: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    textContent: vi.fn(async () => "token=page-secret"),
    waitForUrl: vi.fn(async () => undefined),
    url: vi.fn(() => "https://example.test/after?sig=browser-url-secret"),
    screenshot: vi.fn(async () => Uint8Array.from([137, 80, 78, 71])),
  };
  const browser: BrowserHandle = {
    id: "native-browser-slr_live_must_not_escape",
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  const sandbox: SandboxHandle = {
    id: "native-sandbox-slr_live_must_not_escape",
    exec: vi.fn(async () => ({
      exitCode: 0,
      stdout: "token=sandbox-secret Bearer sandbox-bearer",
      stderr: "",
    })),
    start: vi.fn(),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => new Uint8Array()),
    previewUrl: vi.fn(async () => ({
      url: "https://preview.test/run?token=preview-url-secret",
      token: "slr_live_preview_secret",
    })),
    kill: vi.fn(async () => undefined),
  };
  const desktop: DesktopHandle = {
    id: "native-desktop-slr_live_must_not_escape",
    health: vi.fn(async () => ({ ready: true, display: true, vnc: true })),
    exec: vi.fn(async () => ({
      exitCode: 0,
      stdout: "secret=desktop-secret",
      stderr: "",
    })),
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
  it("turns create and operation provider rejections into recursively sanitized typed errors", async () => {
    const exactSecret = "exact-provider-api-key";
    const failure = (label: string) => {
      const nested = Object.assign(
        new TypeError(`${label} nested ${exactSecret}`),
        {
          name: `${label}-Bearer bearer-provider-secret`,
          payload: {
            token: "raw-token-field",
            message: "token=assigned-provider-secret",
            url: "https://errors.example.test/failure?JWT=jwt-provider-secret",
          },
        },
      );
      return Object.assign(
        new AggregateError(
          [nested, `aggregate child ${exactSecret}`],
          `${label} aggregate ${exactSecret}`,
          { cause: new Error(`cause Bearer cause-provider-secret`) },
        ),
        { detail: { authorization: "nested-authorization-secret" } },
      );
    };
    const fake = fakeSolari();
    fake.services.browser.create = vi.fn(async () => {
      throw failure("create");
    });
    fake.sandbox.exec = vi.fn(async () => {
      throw failure("operation");
    });
    const supervisor = new ResourceSupervisor();
    const broker = createAgentToolBroker({
      workspace: { root: process.cwd(), dispose: async () => undefined },
      plan: {
        primitives: ["browser", "sandbox"],
        reason: { browser: "inspect", sandbox: "execute" },
        verificationStrategy: "inspect safe failures",
      },
      services: fake.services,
      supervisor,
      sink: { emit: async () => undefined, close: () => undefined },
      remainingMs: () => 60_000,
      environment: {},
    });
    const release = registerCredentialValue(exactSecret);
    try {
      const createRejection = await broker
        .invoke("browser_create", {}, new AbortController().signal)
        .catch((error: unknown) => error);
      expect(createRejection).toBeInstanceOf(AgentToolError);
      expect(createRejection).toMatchObject({ code: "execution_failed" });

      await broker.invoke("sandbox_create", {}, new AbortController().signal);
      const operationRejection = await broker
        .invoke(
          "sandbox_exec",
          { handle: "s-1", command: "node", args: [] },
          new AbortController().signal,
        )
        .catch((error: unknown) => error);
      expect(operationRejection).toBeInstanceOf(AgentToolError);
      expect(operationRejection).toMatchObject({ code: "execution_failed" });

      const loggable = [createRejection, operationRejection]
        .map(collectLoggableErrorText)
        .join("\n");
      expect(loggable).toContain("[REDACTED]");
      expect(loggable).not.toMatch(
        /exact-provider-api-key|bearer-provider-secret|raw-token-field|assigned-provider-secret|jwt-provider-secret|cause-provider-secret|nested-authorization-secret/i,
      );
    } finally {
      release();
      await supervisor.cleanup();
    }
  });

  it("redacts arbitrary punctuation assignments from broker rejection causes", async () => {
    const { broker, sandbox, supervisor } = brokerFor(["sandbox"]);
    const failure = Object.assign(
      new Error("provider a/p/i/k/e/y=unregistered-provider-secret", {
        cause: new Error("upstream j+W\\t = 'unregistered-jwt-secret'"),
      }),
      {
        detail: '"AcCeSs!To@Ken": "unregistered-access-secret"',
      },
    );
    sandbox.exec = vi.fn(async () => {
      throw failure;
    });

    try {
      await broker.invoke("sandbox_create", {}, new AbortController().signal);
      const rejection = (await broker
        .invoke(
          "sandbox_exec",
          { handle: "s-1", command: "node", args: [] },
          new AbortController().signal,
        )
        .catch((error: unknown) => error)) as AgentToolError;

      expect(rejection).toBeInstanceOf(AgentToolError);
      expect(rejection.code).toBe("execution_failed");
      expect(rejection.cause).toBeInstanceOf(Error);
      expect(rejection.cause).not.toBe(failure);
      expect((rejection.cause as Error).message).toBe(
        "provider a/p/i/k/e/y=[REDACTED]",
      );
      const loggable = collectLoggableErrorText(rejection);
      expect(loggable).toContain("j+W\\t = '[REDACTED]'");
      expect(loggable).toContain('"AcCeSs!To@Ken": "[REDACTED]"');
      expect(loggable).not.toMatch(
        /unregistered-provider-secret|unregistered-jwt-secret|unregistered-access-secret/,
      );
    } finally {
      await supervisor.cleanup();
    }
  });

  it("replaces hostile frozen provider errors with inert causes without invoking accessors", async () => {
    const exactSecret = "hostile-provider-secret";
    let getterCalls = 0;
    const detail: Record<string, unknown> = {};
    detail.self = detail;
    Object.defineProperty(detail, "jWt", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return exactSecret;
      },
    });
    Object.defineProperty(detail, Symbol.toPrimitive, {
      value: () => exactSecret,
    });
    Object.freeze(detail);

    const hostile = new Error(`provider failed with ${exactSecret}`);
    Object.defineProperty(hostile, "token", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return exactSecret;
      },
    });
    Object.defineProperties(hostile, {
      detail: { enumerable: true, value: detail },
      toString: { value: () => exactSecret },
      valueOf: { value: () => exactSecret },
      [Symbol.toPrimitive]: { value: () => exactSecret },
    });
    Object.freeze(hostile);

    const fake = fakeSolari();
    fake.sandbox.exec = vi.fn(async () => {
      throw hostile;
    });
    const supervisor = new ResourceSupervisor();
    const broker = createAgentToolBroker({
      workspace: { root: process.cwd(), dispose: async () => undefined },
      plan: {
        primitives: ["sandbox"],
        reason: { sandbox: "execute" },
        verificationStrategy: "inspect safe failure",
      },
      services: fake.services,
      supervisor,
      sink: { emit: async () => undefined, close: () => undefined },
      remainingMs: () => 60_000,
      environment: {},
    });
    const release = registerCredentialValue(exactSecret);
    try {
      await broker.invoke("sandbox_create", {}, new AbortController().signal);
      const rejection = (await broker
        .invoke(
          "sandbox_exec",
          { handle: "s-1", command: "node", args: [] },
          new AbortController().signal,
        )
        .catch((error: unknown) => error)) as AgentToolError;

      expect(rejection).toBeInstanceOf(AgentToolError);
      expect(rejection.code).toBe("execution_failed");
      expect(getterCalls).toBe(0);
      expect(rejection.cause === hostile).toBe(false);
      expect(rejection.cause).toBeInstanceOf(Error);
      expect(String(rejection.cause)).not.toContain(exactSecret);
      expect(`${rejection.cause}`).not.toContain(exactSecret);
      const safeCause = rejection.cause as Error & {
        token?: unknown;
        detail?: Record<string, unknown>;
      };
      const tokenDescriptor = Object.getOwnPropertyDescriptor(safeCause, "token");
      expect(tokenDescriptor).toMatchObject({ value: "[REDACTED]" });
      expect(tokenDescriptor).not.toHaveProperty("get");
      expect(tokenDescriptor).not.toHaveProperty("set");
      expect(Object.hasOwn(safeCause, "toString")).toBe(false);
      expect(Object.hasOwn(safeCause, "valueOf")).toBe(false);
      expect(Object.hasOwn(safeCause, Symbol.toPrimitive)).toBe(false);
      const safeDetail = safeCause.detail;
      expect(safeDetail).toBeDefined();
      if (safeDetail === undefined) throw new Error("Expected inert detail clone");
      expect(safeDetail === detail).toBe(false);
      expect(safeDetail.self).toBe(safeDetail);
      const jwtDescriptor = Object.getOwnPropertyDescriptor(safeDetail, "jWt");
      expect(jwtDescriptor).toMatchObject({ value: "[REDACTED]" });
      expect(jwtDescriptor).not.toHaveProperty("get");
      expect(jwtDescriptor).not.toHaveProperty("set");
      expect(Object.hasOwn(safeDetail, Symbol.toPrimitive)).toBe(false);
      expect(collectLoggableErrorText(rejection)).not.toContain(exactSecret);
      expect(getterCalls).toBe(0);
    } finally {
      release();
      await supervisor.cleanup();
    }
  });

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
      ).toEqual({
        exitCode: 0,
        stdout: "token=[REDACTED] Bearer [REDACTED]",
        stderr: "",
        outputTruncated: false,
      });
      expect(sandbox.exec).toHaveBeenCalledWith("node", ["--version"], {
        timeoutMs: 60_000,
      });
      expect(
        await broker.invoke("sandbox_preview", { handle: "s-1", port: 3000 }, signal),
      ).toEqual({ url: "[REDACTED_SIGNED_URL]" });
      expect(JSON.stringify(events)).not.toMatch(
        /native-sandbox|preview_secret|preview-url-secret|sandbox-secret|sandbox-bearer|slr_live/,
      );
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
      ).resolves.toEqual({
        text: "token=[REDACTED]",
        url: "[REDACTED_SIGNED_URL]",
      });
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
        stdout: "secret=[REDACTED]",
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
      expect(JSON.stringify(events)).not.toMatch(
        /native-(browser|desktop)|browser-url-secret|page-secret|desktop-secret|slr_live/,
      );
      expect(JSON.stringify(events)).not.toContain("private form value");
    } finally {
      await supervisor.cleanup();
    }
    expect(browser.close).toHaveBeenCalledOnce();
    expect(desktop.kill).toHaveBeenCalledOnce();
  });

  it("rejects oversized browser and desktop screenshots before return or event publication", async () => {
    const fake = fakeSolari();
    fake.page.screenshot = vi.fn(
      async () => new Uint8Array(5 * 1024 * 1024 + 1),
    );
    fake.desktop.screenshot = vi.fn(
      async () => new Uint8Array(5 * 1024 * 1024 + 1),
    );
    const supervisor = new ResourceSupervisor();
    const events: Array<{ kind: AgentEventKind; payload: unknown }> = [];
    const broker = createAgentToolBroker({
      workspace: { root: process.cwd(), dispose: async () => undefined },
      plan: {
        primitives: ["browser", "desktop"],
        reason: {
          browser: "capture browser evidence",
          desktop: "capture desktop evidence",
        },
        verificationStrategy: "inspect screenshots",
      },
      services: fake.services,
      supervisor,
      sink: {
        emit: async (kind, payload) => {
          events.push({ kind, payload });
        },
        close: () => undefined,
      },
      remainingMs: () => 60_000,
      environment: {},
    });
    const signal = new AbortController().signal;
    try {
      await broker.invoke("browser_create", {}, signal);
      await broker.invoke("desktop_create", {}, signal);
      await expect(
        broker.invoke("browser_screenshot", { handle: "b-1" }, signal),
      ).rejects.toMatchObject({ code: "output_limit" });
      await expect(
        broker.invoke("desktop_screenshot", { handle: "d-1" }, signal),
      ).rejects.toMatchObject({ code: "output_limit" });
      expect(
        events.filter(
          ({ kind, payload }) =>
            kind === "resource-observation" &&
            typeof payload === "object" &&
            payload !== null &&
            "evidenceCandidate" in payload,
        ),
      ).toEqual([]);
    } finally {
      await supervisor.cleanup();
    }
  });

  it("rejects browser text and screenshot payloads that expand past caps during redaction", async () => {
    const fixture = brokerFor(["browser"]);
    const signal = new AbortController().signal;
    fixture.page.textContent = vi.fn(
      async () => "qq".repeat(512 * 1024 - 1),
    );
    fixture.page.screenshot = vi.fn(
      async () => new Uint8Array(5 * 1024 * 1024 - 2),
    );
    try {
      await fixture.broker.invoke("browser_create", {}, signal);

      const releaseText = registerCredentialValue("qq");
      try {
        await expect(
          fixture.broker.invoke(
            "browser_text",
            { handle: "b-1", selector: "main" },
            signal,
          ),
        ).rejects.toMatchObject({ code: "output_limit" });
      } finally {
        releaseText();
      }

      const releaseScreenshot = registerCredentialValue("AAAA");
      try {
        await expect(
          fixture.broker.invoke("browser_screenshot", { handle: "b-1" }, signal),
        ).rejects.toMatchObject({ code: "output_limit" });
      } finally {
        releaseScreenshot();
      }
      expect(
        fixture.events.filter(
          ({ kind, payload }) =>
            kind === "resource-observation" &&
            typeof payload === "object" &&
            payload !== null &&
            (payload as { operation?: unknown }).operation === "screenshot",
        ),
      ).toEqual([]);
    } finally {
      await fixture.supervisor.cleanup();
    }
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
      const rejection = await broker
        .invoke("sandbox_create", {}, new AbortController().signal)
        .catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(AgentToolError);
      expect(rejection).toMatchObject({
        code: "execution_failed",
        cause: expect.objectContaining({ message: "event persistence failed" }),
      });
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
    await vi.waitFor(() => expect(fake.services.sandbox.create).toHaveBeenCalledOnce());
    controller.abort(new Error("run cancelled"));
    finishCreate(fake.sandbox);
    try {
      await expect(creation).rejects.toThrow();
    } finally {
      await supervisor.cleanup();
    }
    expect(fake.sandbox.kill).toHaveBeenCalledOnce();
  });

  it("directly disposes each resource exactly once when supervisor tracking has closed", async () => {
    const fake = fakeSolari();
    let finishBrowser!: (resource: BrowserHandle) => void;
    let finishSandbox!: (resource: SandboxHandle) => void;
    let finishDesktop!: (resource: DesktopHandle) => void;
    fake.services.browser.create = vi.fn(
      () => new Promise<BrowserHandle>((resolve) => {
        finishBrowser = resolve;
      }),
    );
    fake.services.sandbox.create = vi.fn(
      () => new Promise<SandboxHandle>((resolve) => {
        finishSandbox = resolve;
      }),
    );
    fake.services.desktop.create = vi.fn(
      () => new Promise<DesktopHandle>((resolve) => {
        finishDesktop = resolve;
      }),
    );
    const supervisor = new ResourceSupervisor();
    const broker = createAgentToolBroker({
      workspace: { root: process.cwd(), dispose: async () => undefined },
      plan: {
        primitives: ["browser", "sandbox", "desktop"],
        reason: {
          browser: "inspect a page",
          sandbox: "run isolated commands",
          desktop: "inspect a desktop",
        },
        verificationStrategy: "inspect resources",
      },
      services: fake.services,
      supervisor,
      sink: { emit: async () => undefined, close: () => undefined },
      remainingMs: () => 60_000,
      environment: {},
    });
    const signal = new AbortController().signal;

    const browserCreation = broker.invoke("browser_create", {}, signal);
    await vi.waitFor(() => expect(fake.services.browser.create).toHaveBeenCalledOnce());
    await supervisor.cleanup();
    finishBrowser(fake.browser);
    await expect(browserCreation).rejects.toMatchObject({
      code: "resource_tracking_failed",
    });

    const sandboxCreation = broker.invoke("sandbox_create", {}, signal);
    await vi.waitFor(() => expect(fake.services.sandbox.create).toHaveBeenCalledOnce());
    finishSandbox(fake.sandbox);
    await expect(sandboxCreation).rejects.toMatchObject({
      code: "resource_tracking_failed",
    });

    const desktopCreation = broker.invoke("desktop_create", {}, signal);
    await vi.waitFor(() => expect(fake.services.desktop.create).toHaveBeenCalledOnce());
    finishDesktop(fake.desktop);
    await expect(desktopCreation).rejects.toMatchObject({
      code: "resource_tracking_failed",
    });

    expect(fake.browser.close).toHaveBeenCalledOnce();
    expect(fake.sandbox.kill).toHaveBeenCalledOnce();
    expect(fake.desktop.kill).toHaveBeenCalledOnce();
    expect(fake.browser.newPage).not.toHaveBeenCalled();
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
