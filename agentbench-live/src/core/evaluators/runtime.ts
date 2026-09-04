import type { BrowserHandle, DesktopHandle, SandboxHandle, SolariServices } from "@/core/solari/contracts";
import { ResourceSupervisor } from "@/core/solari/resource-supervisor";
import type { EvaluatorFinalizerOutcome, EvaluatorFinalizerResult, EvaluatorResourcePort } from "./types";

export class EvaluatorRuntime implements EvaluatorResourcePort {
  private readonly supervisor = new ResourceSupervisor();
  private readonly outputs = new Map<string, Readonly<Record<string, unknown>>>();
  private readonly finalizers: Array<{
    evaluatorId: string;
    callback: () => Promise<EvaluatorFinalizerOutcome>;
  }> = [];
  private finalizersPromise: Promise<EvaluatorFinalizerResult[]> | undefined;
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
  registerFinalizer(
    evaluatorId: string,
    callback: () => Promise<EvaluatorFinalizerOutcome>,
  ): void {
    if (this.finalizersPromise) {
      throw new Error("Cannot register an evaluator finalizer after finalization has started");
    }
    this.finalizers.push({ evaluatorId, callback });
  }
  runFinalizers(): Promise<EvaluatorFinalizerResult[]> {
    this.finalizersPromise ??= this.performFinalizers();
    return this.finalizersPromise;
  }
  async dispose(): Promise<void> { await this.supervisor.cleanup(); }

  private async performFinalizers(): Promise<EvaluatorFinalizerResult[]> {
    const results: EvaluatorFinalizerResult[] = [];
    for (const { evaluatorId, callback } of this.finalizers) {
      try {
        results.push({ evaluatorId, ...(await callback()) });
      } catch (error) {
        results.push({
          evaluatorId,
          ok: false,
          summary: error instanceof Error ? error.message : String(error),
          assertions: [],
          evidence: [],
          metadata: { finalizerThrew: true },
        });
      }
    }
    return results;
  }
}
