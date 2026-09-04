import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  defaultSubmissionPolicy,
  packageSubmission,
} from "@/core/security/package-submission";
import { redact } from "@/core/security/redact";
import { createWorkspace } from "@/core/security/workspace";

const fixtures: string[] = [];

const printableAsciiPunctuation = [
  ["exclamation mark", "!"],
  ["double quote", '"'],
  ["number sign", "#"],
  ["dollar sign", "$"],
  ["percent sign", "%"],
  ["ampersand", "&"],
  ["single quote", "'"],
  ["left parenthesis", "("],
  ["right parenthesis", ")"],
  ["asterisk", "*"],
  ["plus sign", "+"],
  ["comma", ","],
  ["hyphen-minus", "-"],
  ["full stop", "."],
  ["slash", "/"],
  ["colon", ":"],
  ["semicolon", ";"],
  ["less-than sign", "<"],
  ["equals sign", "="],
  ["greater-than sign", ">"],
  ["question mark", "?"],
  ["commercial at", "@"],
  ["left square bracket", "["],
  ["backslash", "\\"],
  ["right square bracket", "]"],
  ["circumflex accent", "^"],
  ["low line", "_"],
  ["grave accent", "`"],
  ["left curly bracket", "{"],
  ["vertical line", "|"],
  ["right curly bracket", "}"],
  ["tilde", "~"],
] as const;

const unquotedCredentialKeySeparators = [
  ["exclamation mark", "!"],
  ["number sign", "#"],
  ["dollar sign", "$"],
  ["percent sign", "%"],
  ["asterisk", "*"],
  ["plus sign", "+"],
  ["hyphen-minus", "-"],
  ["full stop", "."],
  ["slash", "/"],
  ["question mark", "?"],
  ["commercial at", "@"],
  ["backslash", "\\"],
  ["circumflex accent", "^"],
  ["low line", "_"],
  ["grave accent", "`"],
  ["vertical line", "|"],
  ["tilde", "~"],
] as const;

async function fixtureWorkspace(files: Record<string, string | Uint8Array>) {
  const root = await mkdtemp(join(tmpdir(), "agentbench-fixture-"));
  fixtures.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const destination = join(root, relativePath);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, contents);
  }
  return { root, dispose: async () => undefined };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("redacts keys, bearer headers, signed session URLs, and local roots", () => {
  const input =
    "Bearer slr_live_id_secret https://stream.getsolari.com/signed C:\\Users\\Admin\\repo";
  expect(
    redact(input, { localRoots: ["C:\\Users\\Admin\\repo"] }),
  ).not.toMatch(/secret|signed|Users\\Admin/);
});

test("redacts separator-obfuscated credential assignments without changing safe URLs", () => {
  const input = [
    "A.p-I__K_eY=unregistered-provider-secret",
    "j_W.t = 'unregistered-jwt-secret'",
    '"AcCeSs---To_Ken": "unregistered-access-secret"',
    "ordinary_key=visible",
    "endpoint=https://example.test/path?mode=view",
    "callback=https://identity.example.test/callback?A.p-I__K_eY=url-secret",
  ].join("; ");

  expect(redact(input)).toBe(
    [
      "A.p-I__K_eY=[REDACTED]",
      "j_W.t = '[REDACTED]'",
      '"AcCeSs---To_Ken": "[REDACTED]"',
      "ordinary_key=visible",
      "endpoint=https://example.test/path?mode=view",
      "callback=[REDACTED_SIGNED_URL]",
    ].join("; "),
  );
});

test("redacts punctuation and control separated assignments at every text position", () => {
  const input = [
    "a/p/i/k/e/y=start-slash-secret",
    "ordinary!setting=visible",
    "c+$r^e*|d~e`n\\t?%i@a#l = 'middle-punctuation-secret'",
    '"s!e@c#r$e%t": "quoted-json-secret"',
    "t\u0001o\u0002k\u0003e\u0004n=end-control-secret",
  ].join("; ");

  expect(redact(input)).toBe(
    [
      "a/p/i/k/e/y=[REDACTED]",
      "ordinary!setting=visible",
      "c+$r^e*|d~e`n\\t?%i@a#l = '[REDACTED]'",
      '"s!e@c#r$e%t": "[REDACTED]"',
      "t\u0001o\u0002k\u0003e\u0004n=[REDACTED]",
    ].join("; "),
  );
});

test.each(printableAsciiPunctuation)(
  "bounded assignment lexer accepts the ASCII %s inside a quoted key",
  (_name, separator) => {
    const key = [..."token"].join(separator);
    const input = JSON.stringify({ [key]: "printable-punctuation-secret" });
    const output = redact(input);

    expect(output).toBe(JSON.stringify({ [key]: "[REDACTED]" }));
    expect(JSON.parse(output)).toEqual({ [key]: "[REDACTED]" });
  },
);

test.each(unquotedCredentialKeySeparators)(
  "bounded assignment lexer accepts the ASCII %s inside an unquoted key",
  (_name, separator) => {
    const key = [..."apikey"].join(separator);

    expect(redact(`${key}=unquoted-punctuation-secret`)).toBe(
      `${key}=[REDACTED]`,
    );
  },
);

test("bounded assignment lexer preserves structural boundaries and controls", () => {
  const input = [
    "token=start-secret",
    "(token=parenthesized-secret)",
    "[token=bracketed-secret]",
    "{token=braced-secret}",
    "<token=angled-secret>",
    "ordinary=visible,token=comma-secret",
    "ordinary=visible;token=semicolon-secret",
    "ordinary=visible&token=ampersand-secret",
    "ordinary=visible\ntoken=newline-secret",
    "t\u0001o\u0002k\u0003e\u0004n=control-secret",
  ].join(" | ");

  expect(redact(input)).toBe(
    [
      "token=[REDACTED]",
      "(token=[REDACTED])",
      "[token=[REDACTED]]",
      "{token=[REDACTED]}",
      "<token=[REDACTED]>",
      "ordinary=visible,token=[REDACTED]",
      "ordinary=visible;token=[REDACTED]",
      "ordinary=visible&token=[REDACTED]",
      "ordinary=visible\ntoken=[REDACTED]",
      "t\u0001o\u0002k\u0003e\u0004n=[REDACTED]",
    ].join(" | "),
  );
});

test("bounded assignment lexer preserves values, JSON, and assignment syntax", () => {
  const json = JSON.stringify({
    "a,p,i,k,e,y": "comma-secret",
    "prefix/s:e[c]{r}=e t": "escaped \\\"quote\\\", comma, equals=secret",
    input_tokens: 20,
    output_tokens: false,
    token_count: null,
    ordinary: "token=embedded-secret",
  });
  const expectedJson = JSON.stringify({
    "a,p,i,k,e,y": "[REDACTED]",
    "prefix/s:e[c]{r}=e t": "escaped \\\"quote\\\", comma, equals=secret",
    input_tokens: 20,
    output_tokens: false,
    token_count: null,
    ordinary: "token=[REDACTED]",
  });
  const assignments = String.raw`'a\'p\'i\'k\'e\'y' = 'single \' quote'; jwt="double \" quote"; token=unquoted; credential=[REDACTED]`;

  const redactedJson = redact(json);
  expect(redactedJson).toBe(expectedJson);
  expect(JSON.parse(redactedJson)).toEqual(JSON.parse(expectedJson));
  expect(redact(assignments)).toBe(
    String.raw`'a\'p\'i\'k\'e\'y' = '[REDACTED]'; jwt="[REDACTED]"; token=[REDACTED]; credential=[REDACTED]`,
  );
});

test("structured redaction decodes escaped keys and replaces credential containers", () => {
  const input =
    '{"t\\u006fken":{"nested":"secret"},"api\\u005fkey":["secret"],"token_details":{"cached":2},"input_tokens":20,"tokens":[1,2],"max_tokens":100,"ordinary":"token=embedded-secret"}';

  const output = redact(input);

  expect(JSON.parse(output)).toEqual({
    token: "[REDACTED]",
    api_key: "[REDACTED]",
    token_details: { cached: 2 },
    input_tokens: 20,
    tokens: [1, 2],
    max_tokens: 100,
    ordinary: "token=[REDACTED]",
  });
});

test("structured redaction preserves telemetry and redacts nested exact keys", () => {
  const input = JSON.stringify({
    token_count: null,
    output_tokens: false,
    token_usage: { total_tokens: 10, access_token: "secret" },
    result: { password: { nested: true }, client_secret: ["secret"] },
  });

  expect(JSON.parse(redact(input))).toEqual({
    token_count: null,
    output_tokens: false,
    token_usage: { total_tokens: 10, access_token: "[REDACTED]" },
    result: {
      password: "[REDACTED]",
      client_secret: "[REDACTED]",
    },
  });
});

test("structured redaction preserves prototype-named JSON fields as own data", () => {
  const output = redact(
    '{"__proto__":{"token":"secret"},"constructor":"visible"}',
  );

  expect(JSON.parse(output)).toEqual(
    JSON.parse(
      '{"__proto__":{"token":"[REDACTED]"},"constructor":"visible"}',
    ),
  );
  expect(output).toContain('"__proto__"');
});

test("free-text redaction shields safe OAuth URLs from assignment scanning", () => {
  expect(
    redact("endpoint=https://example.test/oauth/token?mode=view"),
  ).toBe("endpoint=https://example.test/oauth/token?mode=view");
  expect(
    redact("callback=https://example.test/cb?api_key=secret"),
  ).toBe("callback=[REDACTED_SIGNED_URL]");
});

test("free-text redaction preserves quotes around embedded assignments", () => {
  const input = String.raw`note="token=abc\"def"`;
  expect(redact(input)).toBe(String.raw`note="token=[REDACTED]"`);
});

test.each([
  [127, "[REDACTED]"],
  [128, "[REDACTED]"],
  [129, "visible"],
] as const)(
  "bounded assignment lexer enforces a %i-character key limit",
  (length, expectedValue) => {
    const key = `token${"!".repeat(length - "token".length)}`;
    const quoted = JSON.stringify({ [key]: "visible" });

    expect(key).toHaveLength(length);
    expect(redact(`${key}=visible`)).toBe(`${key}=${expectedValue}`);
    expect(redact(quoted)).toBe(
      JSON.stringify({ [key]: "[REDACTED]" }),
    );
  },
);

test("bounded assignment lexer does not swallow prose, prior values, or containers", () => {
  const ordinaryText = [
    "The token is discussed before ordinary=value",
    "A secret appears in prose before setting=visible",
    "api/key, ordinary=value",
    "[api/key] another=value",
    "(api/key) final=value",
    "ordinary prose 1/2 = fraction",
    "ordinary_key=visible",
    "endpoint=https://example.test/path?mode=view",
  ].join("; ");

  expect(redact(ordinaryText)).toBe(ordinaryText);
});

test("uses quotes and container punctuation as assignment-key boundaries", () => {
  const credentialJson =
    '{"a/p/i/k/e/y":"json-secret","a/p/i/k/e/\\"/y":"escaped-quote-secret","ordinary/key":"visible","input_tokens":20}';
  const ordinaryText = [
    "api/key, ordinary=value",
    "[api/key] another=value",
    "(api/key) final=value",
    "ordinary prose 1/2 = fraction",
  ].join("; ");

  const redactedJson = redact(credentialJson);
  expect(redactedJson).toBe(
    '{"a/p/i/k/e/y":"[REDACTED]","a/p/i/k/e/\\"/y":"[REDACTED]","ordinary/key":"visible","input_tokens":20}',
  );
  expect(JSON.parse(redactedJson)).toEqual({
    "a/p/i/k/e/y": "[REDACTED]",
    'a/p/i/k/e/"/y': "[REDACTED]",
    "ordinary/key": "visible",
    input_tokens: 20,
  });
  expect(redact(ordinaryText)).toBe(ordinaryText);
});

test("bounds punctuation-heavy assignment keys to 128 characters", () => {
  const atLimit = `a/p/i/k/e/y${"!".repeat(117)}`;
  const beyondLimit = `a/p/i/k/e/y${"!".repeat(118)}`;
  const quotedAssignments = `{"${atLimit}":"quoted-secret","${beyondLimit}":"visible"}`;

  expect(atLimit).toHaveLength(128);
  expect(beyondLimit).toHaveLength(129);
  expect(redact(`${atLimit}=bounded-secret; ${beyondLimit}=visible`)).toBe(
    `${atLimit}=[REDACTED]; ${beyondLimit}=visible`,
  );
  expect(redact(quotedAssignments)).toBe(
    `{"${atLimit}":"[REDACTED]","${beyondLimit}":"[REDACTED]"}`,
  );
});

test("rejects dotenv files", async () => {
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/.env": "SOLARI_API_KEY=leak",
  });
  await expect(
    packageSubmission(workspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/\.env/);
});

test("rejects symlinks inside the submission", async () => {
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "outside/not-submission-data.txt": "not submission data",
  });
  await symlink(
    join(workspace.root, "outside"),
    join(workspace.root, "submission", "linked"),
    "junction",
  );
  await expect(
    packageSubmission(workspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/symlink/i);
});

test("requires valid results JSON", async () => {
  const workspace = await fixtureWorkspace({
    "submission/results.json": "not json",
  });
  await expect(
    packageSubmission(workspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/results\.json/i);
});

test("rejects signed Solari URLs and Solari token fields", async () => {
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/provenance.json": JSON.stringify({
      replay: "https://stream.getsolari.com/session/signed?token=top-secret",
      solariStreamToken: "abc1234567890secret",
    }),
  });

  await expect(
    packageSubmission(workspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/secret material/i);
});

test("rejects AWS-style Solari signatures and standalone preview token fields", async () => {
  const signedUrlWorkspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/provenance.json": JSON.stringify({
      replay:
        "https://stream.getsolari.com/session/123?X-Amz-Signature=abcdef1234567890",
    }),
  });
  const tokenWorkspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/provenance.json": JSON.stringify({
      token: "abcdef1234567890",
    }),
  });

  await expect(
    packageSubmission(signedUrlWorkspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/secret material/i);
  await expect(
    packageSubmission(tokenWorkspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/secret material/i);
});

test("packages validated allowlisted PNG and JPEG artifacts as binary entries", async () => {
  const png = await readFile(resolve("public/demo/url-shortener-browser.png"));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/artifacts/proof.png": png,
    "submission/artifacts/proof.jpg": jpeg,
  });

  const packaged = await packageSubmission(workspace, defaultSubmissionPolicy);

  expect(packaged.entries["artifacts/proof.png"]).toMatchObject({
    kind: "binary",
    mediaType: "image/png",
  });
  expect(packaged.entries["artifacts/proof.jpg"]).toMatchObject({
    kind: "binary",
    mediaType: "image/jpeg",
  });
});

test("scans raw binary bytes for secret material before accepting an artifact", async () => {
  const png = await readFile(resolve("public/demo/url-shortener-browser.png"));
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/artifacts/proof.png": Buffer.concat([
      png,
      Buffer.from("SOLARI_API_KEY=slr_live_binary_secret", "ascii"),
    ]),
  });

  await expect(
    packageSubmission(workspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/secret material/i);
});

test("rejects binary artifacts outside the explicit extension allowlist", async () => {
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/artifacts/archive.zip": new Uint8Array([0x50, 0x4b, 3, 4, 0]),
  });
  await expect(
    packageSubmission(workspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/binary files are not allowed/i);
});

test("rejects a text file masquerading as an allowlisted image artifact", async () => {
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/artifacts/not-an-image.png": "this is plain text",
  });
  await expect(
    packageSubmission(workspace, defaultSubmissionPolicy),
  ).rejects.toThrow(/invalid PNG artifact/i);
});

test("hashes sorted submission paths and bytes", async () => {
  const workspace = await fixtureWorkspace({
    "submission/results.json": "{}",
    "submission/methodology.md": "method",
  });
  const packaged = await packageSubmission(workspace, defaultSubmissionPolicy);
  const expected = createHash("sha256")
    .update("methodology.md\0method")
    .update("results.json\0{}")
    .digest("hex");
  expect(packaged).toEqual({
    entries: {
      "methodology.md": { kind: "text", contents: "method" },
      "results.json": { kind: "text", contents: "{}" },
    },
    digest: expected,
  });
});

test("creates a Git workspace and disposes only that workspace", async () => {
  const workspace = await createWorkspace("run-1");
  expect((await lstat(join(workspace.root, ".git"))).isDirectory()).toBe(true);
  await workspace.dispose();
  await expect(lstat(workspace.root)).rejects.toMatchObject({ code: "ENOENT" });
});
