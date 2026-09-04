import type { BrowserHandle, DesktopHandle, SandboxHandle, SolariServices } from "@/core/solari/contracts";
import { ResourceSupervisor } from "@/core/solari/resource-supervisor";
import type { EvaluatorResourcePort } from "./types";

export class EvaluatorRuntime implements EvaluatorResourcePort {
  private readonly supervisor = new ResourceSupervisor();
  private readonly outputs = new Map<string, Readonly<Record<string, unknown>>>();
  constructor(private readonly services: SolariServices) {}

  async acquireSandbox(_label: string, options?: { timeoutMs?: number }): Promise<SandboxHandle> {
    const sandbox = await this.services.sandbox.create(options);
    this.supervisor.trackSandbox(sandbox);
    return sandbox;
  }
  async acquireBrowser(_label: string, options?: { recording?: boolean }): Promise<BrowserHandle> {
    const browser = await this.services.browser.create(options);
    this.supervisor.trackBrowser(browser);
    return browser;
  }
  async acquireDesktop(_label: string, options?: { timeoutMs?: number }): Promise<DesktopHandle> {
    const desktop = await this.services.desktop.create(options);
    this.supervisor.trackDesktop(desktop);
    return desktop;
  }
  publishOutputs(evaluatorId: string, outputs: Record<string, unknown>): void {
    this.outputs.set(evaluatorId, Object.freeze({ ...outputs }));
  }
  getOutput(evaluatorId: string, key: string): unknown { return this.outputs.get(evaluatorId)?.[key]; }
  async dispose(): Promise<void> { await this.supervisor.cleanup(); }
}
