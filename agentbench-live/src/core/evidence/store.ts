import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redactCredentialOutput, redactCredentialText } from "@/core/credentials/redaction";
import { sortEvidence, type EvidenceManifest } from "./manifest";
import type { EvidenceReference, EvidenceWriteBase, EvidenceWriter } from "./types";

type EvidenceStoreOptions = {
  root: string;
  runId: string;
  taskId: string;
  exactSecretValues?: readonly string[];
};

const safeIdentity = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export class EvidenceStore implements EvidenceWriter {
  private readonly root: string;
  private readonly runId: string;
  private readonly taskId: string;
  private readonly exactSecretValues: readonly string[];
  private manifestQueue: Promise<void> = Promise.resolve();

  constructor(options: EvidenceStoreOptions) {
    if (!safeIdentity.test(options.runId) || !safeIdentity.test(options.taskId)) throw new Error("Evidence identities must be safe path segments");
    this.root = options.root;
    this.runId = options.runId;
    this.taskId = options.taskId;
    this.exactSecretValues = options.exactSecretValues ?? [];
  }

  async putBytes(input: EvidenceWriteBase & { bytes: Uint8Array }): Promise<EvidenceReference> {
    const textual = input.mimeType.startsWith("text/") || input.mimeType === "application/json";
    const bytes = textual
      ? Buffer.from(redactCredentialText(Buffer.from(input.bytes).toString("utf8"), { exactValues: this.exactSecretValues }))
      : Buffer.from(input.bytes);
    return this.persist(input, bytes);
  }

  async putText(input: EvidenceWriteBase & { text: string }): Promise<EvidenceReference> {
    const text = redactCredentialText(input.text, { exactValues: this.exactSecretValues });
    return this.persist(input, Buffer.from(text));
  }

  async putJson(input: EvidenceWriteBase & { value: unknown }): Promise<EvidenceReference> {
    const value = redactCredentialOutput(input.value, { exactValues: this.exactSecretValues });
    return this.persist(input, Buffer.from(JSON.stringify(value)));
  }

  async get(digest: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid evidence digest");
    return readFile(this.blobPath(digest));
  }

  async readManifest(): Promise<EvidenceManifest> {
    try {
      return JSON.parse(await readFile(this.manifestPath(), "utf8")) as EvidenceManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { schemaVersion: 1, runId: this.runId, taskId: this.taskId, entries: [] };
    }
  }

  private blobPath(digest: string): string {
    return join(this.root, "sha256", digest.slice(0, 2), digest);
  }

  private manifestPath(): string {
    return join(this.root, "manifests", `${this.runId}.json`);
  }

  private async persist(input: EvidenceWriteBase, bytes: Buffer): Promise<EvidenceReference> {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const path = this.blobPath(digest);
    try {
      const existing = await readFile(path);
      if (existing.length !== bytes.length || createHash("sha256").update(existing).digest("hex") !== digest) throw new Error(`Corrupt evidence blob: ${digest}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWrite(path, bytes);
      if ((await stat(path)).size !== bytes.length) throw new Error(`Evidence write failed: ${digest}`);
    }
    const reference: EvidenceReference = {
      digest, size: bytes.length, mimeType: input.mimeType, role: input.role, producer: input.producer,
      runId: this.runId, taskId: this.taskId, ...(input.evaluatorId ? { evaluatorId: input.evaluatorId } : {}),
      createdAt: new Date().toISOString(), redacted: true,
    };
    await this.appendManifest(reference);
    return reference;
  }

  private async appendManifest(reference: EvidenceReference): Promise<void> {
    const operation = this.manifestQueue.then(async () => {
      const manifest = await this.readManifest();
      const exists = manifest.entries.some((item) => item.digest === reference.digest && item.role === reference.role && item.evaluatorId === reference.evaluatorId);
      if (exists) return;
      const next = { ...manifest, entries: sortEvidence([...manifest.entries, reference]) };
      await atomicWrite(this.manifestPath(), Buffer.from(JSON.stringify(next, null, 2)));
    });
    this.manifestQueue = operation.catch(() => undefined);
    return operation;
  }
}
