import {
  Solari,
  type BrowserSession,
  type ReplayUrl,
} from "@solarisdk/browser";
import { DesktopClient, type Desktop } from "@solarisdk/desktop";
import { SandboxClient, type Sandbox } from "@solarisdk/sandbox";
import type {
  BrowserHandle,
  BrowserPageHandle,
  BrowserService,
  DesktopHandle,
  DesktopService,
  SandboxHandle,
  SandboxService,
  SolariServices,
} from "./contracts";

const defaultBaseUrl = "https://api.getsolari.com";
const liveServices = new WeakSet<SolariServices>();

function missingCredential(): Error & { code: "missing_credential"; credential: "SOLARI_API_KEY" } {
  return Object.assign(new Error("SOLARI_API_KEY is required to provision Solari resources"), { code: "missing_credential" as const, credential: "SOLARI_API_KEY" as const });
}

function unavailableSolariServices(): SolariServices {
  const reject = async (): Promise<never> => { throw missingCredential(); };
  return {
    browser: { create: reject, listIds: async () => [], release: async () => undefined, getReplayUrl: reject },
    sandbox: { create: reject, connect: reject, listIds: async () => [], kill: async () => undefined },
    desktop: { create: reject, listIds: async () => [], kill: async () => undefined },
    dispose: async () => undefined,
  };
}

class BrowserPageAdapter implements BrowserPageHandle {
  constructor(
    private readonly page: Awaited<ReturnType<BrowserSession["newPage"]>>,
  ) {}

  async goto(url: string): Promise<void> {
    await this.page.goto(url);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.page.fill(selector, value);
  }

  async click(selector: string): Promise<void> {
    await this.page.click(selector);
  }

  textContent(selector: string): Promise<string | null> {
    return this.page.textContent(selector);
  }

  async waitForUrl(url: string | RegExp, timeoutMs = 30_000): Promise<void> {
    await this.page.waitForURL(url, { timeout: timeoutMs });
  }

  url(): string {
    return this.page.url();
  }

  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array(await this.page.screenshot({ type: "png" }));
  }
}

class BrowserHandleAdapter implements BrowserHandle {
  readonly id: string;

  constructor(private readonly session: BrowserSession) {
    this.id = session.id;
  }

  async newPage(): Promise<BrowserPageHandle> {
    return new BrowserPageAdapter(await this.session.newPage());
  }

  close(): Promise<void> {
    return this.session.close();
  }
}

export class BrowserServiceAdapter implements BrowserService {
  constructor(private readonly client: Solari) {}

  async create(options = {}): Promise<BrowserHandle> {
    return new BrowserHandleAdapter(await this.client.launch(options));
  }

  async listIds(): Promise<string[]> {
    const response = await this.client.request("GET", "/sessions");
    if (response.status === 404 || response.status === 405) return [];
    if (!response.ok) {
      throw new Error(`Solari session inventory failed: ${response.status}`);
    }
    const payload: unknown = await response.json();
    const sessions = Array.isArray(payload)
      ? payload
      : typeof payload === "object" && payload !== null && "sessions" in payload
        ? (payload as { sessions: unknown }).sessions
        : [];
    if (!Array.isArray(sessions)) return [];
    return sessions.flatMap((session) => {
      if (typeof session !== "object" || session === null) return [];
      const value = session as { id?: unknown; sessionId?: unknown };
      const id = value.id ?? value.sessionId;
      return typeof id === "string" ? [id] : [];
    });
  }

  release(id: string): Promise<void> {
    return this.client.sessions.releaseAndWait(id);
  }

  async getReplayUrl(
    id: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const replay: ReplayUrl = await this.client.sessions.getReplayUrl(id);
    return { url: replay.url, expiresInSeconds: replay.expiresInSeconds };
  }

  dispose(): Promise<void> {
    return this.client.close();
  }
}

class SandboxHandleAdapter implements SandboxHandle {
  readonly id: string;

  constructor(private readonly sandbox: Sandbox) {
    this.id = sandbox.id;
  }

  exec(
    command: string,
    args: string[] = [],
    options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
  ) {
    return this.sandbox.commands.run(command, { args, ...options });
  }

  async start(command: string, args: string[] = [], options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}) {
    const process = await this.sandbox.commands.start(command, {
      args,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      background: true,
    });
    const completion = process.wait();
    void completion.catch(() => undefined);
    return {
      wait: () => completion,
      kill: () => process.kill(),
    };
  }

  mkdir(path: string): Promise<void> {
    return this.sandbox.files.mkdir(path);
  }

  writeFile(path: string, contents: string | Uint8Array): Promise<void> {
    return this.sandbox.files.write(path, contents);
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.sandbox.files.read(path);
  }

  previewUrl(port: number): Promise<{ url: string; token?: string }> {
    return this.sandbox.previewUrl(port);
  }

  kill(): Promise<void> {
    return this.sandbox.kill();
  }
}

export class SandboxServiceAdapter implements SandboxService {
  constructor(private readonly client: SandboxClient) {}

  async create(options = {}): Promise<SandboxHandle> {
    const sandbox = await this.client.create(options);
    try {
      await sandbox.connect();
    } catch (error) {
      await sandbox.kill().catch(() => undefined);
      throw error;
    }
    return new SandboxHandleAdapter(sandbox);
  }

  async connect(id: string): Promise<SandboxHandle> {
    const sandbox = await this.client.connect(id);
    await sandbox.connect();
    return new SandboxHandleAdapter(sandbox);
  }

  async listIds(): Promise<string[]> {
    const response = await this.client.list({ kind: "sandbox" });
    return response.sandboxes.map((sandbox) => sandbox.sandboxId);
  }

  kill(id: string): Promise<void> {
    return this.client.kill(id);
  }
}

class DesktopHandleAdapter implements DesktopHandle {
  readonly id: string;

  constructor(private readonly desktop: Desktop) {
    this.id = desktop.id;
  }

  health() {
    return this.desktop.health();
  }

  exec(
    command: string,
    args: string[] = [],
    options: { cwd?: string; timeoutMs?: number } = {},
  ) {
    return this.desktop.exec(command, { args, ...options });
  }

  open(application: string, args: string[] = []): Promise<number> {
    return this.desktop.open(application, args);
  }

  type(text: string): Promise<void> {
    return this.desktop.keyboard.type(text);
  }

  screenshot(): Promise<Uint8Array> {
    return this.desktop.screenshot({ format: "png" });
  }

  kill(): Promise<void> {
    return this.desktop.kill();
  }
}

export class DesktopServiceAdapter implements DesktopService {
  constructor(
    private readonly client: DesktopClient,
    private readonly inventoryClient: SandboxClient,
  ) {}

  async create(options = {}): Promise<DesktopHandle> {
    const desktop = await this.client.create(options);
    try {
      await desktop.connect();
    } catch (error) {
      await desktop.kill().catch(() => undefined);
      throw error;
    }
    return new DesktopHandleAdapter(desktop);
  }

  async listIds(): Promise<string[]> {
    const response = await this.inventoryClient.list({ kind: "desktop" });
    return response.sandboxes.map((desktop) => desktop.sandboxId);
  }

  async kill(id: string): Promise<void> {
    await this.client.destroy(id);
  }
}

export function createSolariServices(
  apiKey: string,
  baseUrl = defaultBaseUrl,
): SolariServices {
  if (!apiKey.trim()) return unavailableSolariServices();
  const browserClient = new Solari({ apiKey, baseUrl });
  const sandboxClient = new SandboxClient({ apiKey, baseUrl });
  const desktopClient = new DesktopClient({ apiKey, baseUrl });
  const services: SolariServices = {
    browser: new BrowserServiceAdapter(browserClient),
    sandbox: new SandboxServiceAdapter(sandboxClient),
    desktop: new DesktopServiceAdapter(desktopClient, sandboxClient),
    dispose: () => browserClient.close(),
  };
  liveServices.add(services);
  return services;
}

export function isLiveSolariServices(services: SolariServices): boolean {
  return liveServices.has(services);
}
