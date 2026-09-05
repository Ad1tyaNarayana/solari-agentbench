export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type SandboxProcess = {
  wait(): Promise<number>;
  kill(): Promise<void>;
};

export interface SandboxHandle {
  id: string;
  exec(
    command: string,
    args?: string[],
    options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
  ): Promise<ExecResult>;
  start(
    command: string,
    args?: string[],
    options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
  ): Promise<SandboxProcess>;
  mkdir(path: string): Promise<void>;
  writeFile(path: string, contents: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  previewUrl(port: number): Promise<{ url: string; token?: string }>;
  kill(): Promise<void>;
}

export interface SandboxService {
  create(options?: { timeoutMs?: number }): Promise<SandboxHandle>;
  connect(id: string): Promise<SandboxHandle>;
  listIds(): Promise<string[]>;
  kill(id: string): Promise<void>;
}

export interface BrowserPageHandle {
  goto(url: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  waitForUrl(url: string | RegExp, timeoutMs?: number): Promise<void>;
  url(): string;
  screenshot(): Promise<Uint8Array>;
}

export interface BrowserHandle {
  id: string;
  newPage(): Promise<BrowserPageHandle>;
  close(): Promise<void>;
}

export interface BrowserService {
  create(options?: {
    recording?: boolean;
    stealth?: boolean;
  }): Promise<BrowserHandle>;
  listIds(): Promise<string[]>;
  release(id: string): Promise<void>;
  getReplayUrl(
    id: string,
  ): Promise<{ url: string; expiresInSeconds: number; events?: unknown[] }>;
}

export interface DesktopHandle {
  id: string;
  health(): Promise<{ ready: boolean; display: boolean; vnc: boolean }>;
  exec(
    command: string,
    args?: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<ExecResult>;
  open(application: string, args?: string[]): Promise<number>;
  type(text: string): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  kill(): Promise<void>;
}

export interface DesktopService {
  create(options?: {
    timeoutMs?: number;
    resolution?: string;
    record?: boolean;
  }): Promise<DesktopHandle>;
  listIds(): Promise<string[]>;
  kill(id: string): Promise<void>;
}

export type SolariServices = {
  browser: BrowserService;
  sandbox: SandboxService;
  desktop: DesktopService;
  dispose?: () => Promise<void>;
};
