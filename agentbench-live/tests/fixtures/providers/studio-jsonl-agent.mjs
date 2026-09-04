import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.type === "initialize") {
    send({ protocolVersion: 1, type: "initialized", requestId: message.requestId });
  } else if (message.type === "plan") {
    send({ protocolVersion: 1, type: "plan_result", requestId: message.requestId, plan: {
      primitives: [], reason: {}, verificationStrategy: "deterministic file evaluator",
    } });
  } else if (message.type === "execute") {
    const submission = join(message.workspace.root, "submission");
    await mkdir(submission, { recursive: true });
    await writeFile(join(submission, "results.json"), "{}\n");
    send({ protocolVersion: 1, type: "event", event: { kind: "artifact", payload: { path: "submission/results.json" } } });
    send({ protocolVersion: 1, type: "result", requestId: message.requestId, result: { resolvedModel: "fixture-v1", finalResponse: "wrote results.json" } });
  } else if (message.type === "cancel") {
    process.exit(0);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
