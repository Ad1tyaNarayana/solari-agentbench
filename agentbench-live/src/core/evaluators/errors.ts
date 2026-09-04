export class EvaluatorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluatorConfigurationError";
  }
}
