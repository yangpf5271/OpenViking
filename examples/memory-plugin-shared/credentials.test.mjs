import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeCredentialText, resolveOpenVikingCredentials } from "./lib/credentials.mjs";

test("normalizeCredentialText leaves ASCII and Latin-1 credentials byte-identical", () => {
  assert.equal(normalizeCredentialText("bXktYWNjb3VudC51c2VyLk5TZkQ"), "bXktYWNjb3VudC51c2VyLk5TZkQ");
  assert.equal(normalizeCredentialText("café-ünicode-key"), "café-ünicode-key");
  assert.equal(normalizeCredentialText(""), "");
});

test("normalizeCredentialText folds editor damage back to the intended ASCII", () => {
  // "..." rewritten as a typographic ellipsis (the ByteString incident)
  assert.equal(normalizeCredentialText("key\u2026abc"), "key...abc");
  // smart quotes and lengthened dashes
  assert.equal(normalizeCredentialText("\u201Ck\u201D\u2014v"), '"k"-v');
  // full-width forms
  assert.equal(normalizeCredentialText("\uFF21\uFF22\uFF23_\uFF10\uFF11"), "ABC_01");
  // BOM, zero-width characters and soft hyphens disappear
  assert.equal(normalizeCredentialText("\uFEFFke\u200By\u00AD1"), "key1");
});

test("normalizeCredentialText trims whitespace including full-width spaces", () => {
  assert.equal(normalizeCredentialText("  key  "), "key");
  assert.equal(normalizeCredentialText("\u3000key\u3000"), "key");
});

test("normalizeCredentialText keeps text with no ASCII equivalent untouched", () => {
  assert.equal(normalizeCredentialText("密钥\u2026"), "密钥...");
});

test("resolveOpenVikingCredentials normalizes a hand-edited ovcli.conf", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ov-cred-"));
  const conf = join(dir, "ovcli.conf");
  try {
    // The key a human meant: "abc...xyz" — as an editor would mangle it.
    await writeFile(conf, JSON.stringify({
      url: "http://127.0.0.1:1933",
      api_key: "\uFEFF abc\u2026xyz ",
    }) + "\n", "utf8");
    const resolved = resolveOpenVikingCredentials({ OPENVIKING_CLI_CONFIG_FILE: conf });
    assert.equal(resolved.apiKey, "abc...xyz");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
