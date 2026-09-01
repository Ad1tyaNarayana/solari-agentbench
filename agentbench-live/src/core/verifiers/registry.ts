import type {
  VerificationContext,
  VerificationResult,
  VerifierRegistryPort,
} from "@/core/runner/contracts";
import type { SolariServices } from "@/core/solari/contracts";
import { SameStatsVerifier } from "./same-stats";
import { UrlShortenerVerifier } from "./url-shortener";

type TaskVerifier = {
  verify(context: VerificationContext): Promise<VerificationResult>;
};

export class VerifierRegistry implements VerifierRegistryPort {
  private readonly verifiers: Map<string, TaskVerifier>;

  constructor(services: SolariServices) {
    this.verifiers = new Map<string, TaskVerifier>([
      ["url-shortener", new UrlShortenerVerifier(services)],
      ["same-stats-different-graph", new SameStatsVerifier(services)],
    ]);
  }

  get(taskId: string): TaskVerifier {
    const verifier = this.verifiers.get(taskId);
    if (!verifier) throw new Error(`Unknown verifier: ${taskId}`);
    return verifier;
  }

  verify(context: VerificationContext): Promise<VerificationResult> {
    return this.get(context.task.id).verify(context);
  }
}
