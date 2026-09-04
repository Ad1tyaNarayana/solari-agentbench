import readline from "node:readline";

const mode = process.argv[2] ?? "happy";
const protocolVersion = 1;
const send = (message) => process.stdout.write(`${JSON.stringify({ protocolVersion, ...message })}\n`);

if (mode === "malformed") {
  process.stdout.write("{malformed\n");
} else if (mode === "oversized") {
  process.stdout.write(`${"x".repeat(1024 * 1024 + 1)}\n`);
} else {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "initialize") {
      send({ type: "initialized", requestId: message.requestId, agent: "fake" });
      return;
    }
    if (message.type === "plan") {
      send({
        type: "plan_result",
        requestId: message.requestId,
        plan: {
          primitives: ["sandbox"],
          reason: { sandbox: "run isolated checks" },
          verificationStrategy: "inspect the generated result",
        },
      });
      lines.close();
      return;
    }
    if (message.type === "execute") {
      if (mode === "nonzero") {
        process.stderr.write("Bearer child-secret\n");
        process.exit(7);
      }
      if (mode === "hang") return;
      send({
        type: "event",
        event: { kind: "message", payload: { text: "working" } },
      });
      send({
        type: "tool_request",
        requestId: "tool-1",
        name: "workspace_read",
        arguments: { path: "prompt.md" },
      });
      if (mode === "duplicate") {
        send({
          type: "tool_request",
          requestId: "tool-1",
          name: "workspace_read",
          arguments: { path: "again.md" },
        });
      }
      return;
    }
    if (message.type === "tool_result") {
      if (mode === "invalidresult") {
        send({
          type: "result",
          requestId: "execute-1",
          result: { usage: "not-an-object" },
        });
        lines.close();
        return;
      }
      send({
        type: "result",
        requestId: "execute-1",
        result: {
          resolvedModel: "fake-model",
          finalResponse: "finished",
          usage: { inputTokens: 3, outputTokens: 2 },
        },
      });
      lines.close();
      return;
    }
    if (message.type === "cancel") {
      process.stderr.write("cancelled Bearer child-secret\n");
      lines.close();
    }
  });
}
