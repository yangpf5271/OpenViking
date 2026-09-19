import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assessProbes,
  assessReady,
  checkWorkspace,
  classifyFetchError,
  createReport,
  credentialSources,
  describeApiKey,
  resolveWindowsCommand,
  runCommand,
  inspectJsonFile,
  lintBaseUrl,
  lintServerConf,
  readyCheckState,
  scanDebugLog,
  unknownOvcliKeys,
  WORKSPACE_PEER_HINT,
} from "./lib/doctor-core.mjs";

const b64 = (s) => Buffer.from(s).toString("base64url");

test("resolveWindowsCommand walks PATH × PATHEXT the way cmd.exe does", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ov-doctor-cmd-")));
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  writeFileSync(join(first, "tool.CMD"), "");
  writeFileSync(join(second, "tool.EXE"), "");
  const env = { PATH: `${first}${delimiter}${second}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  // The first directory on PATH wins, even when a later one holds a real
  // executable — cmd.exe never keeps scanning after a PATHEXT match.
  assert.equal(resolveWindowsCommand("tool", env), join(first, "tool.CMD"));
  // Within one directory, PATHEXT order decides (.EXE before .BAT/.CMD).
  // Files are spelled like the PATHEXT candidates; on Windows's
  // case-insensitive filesystem either casing matches.
  writeFileSync(join(second, "other.EXE"), "");
  writeFileSync(join(second, "other.CMD"), "");
  assert.equal(resolveWindowsCommand("other", { ...env, PATH: second }), join(second, "other.EXE"));
  // A name that already carries an extension or a path is used as given.
  assert.equal(resolveWindowsCommand("tool.exe", env), "tool.exe");
  assert.equal(resolveWindowsCommand(join(first, "tool.CMD"), env), join(first, "tool.CMD"));
  // Nothing found → "" — runCommand keeps the bare name and reports not found.
  assert.equal(resolveWindowsCommand("missing", env), "");
  assert.equal(resolveWindowsCommand("tool", { PATH: "", PATHEXT: ".EXE" }), "");
});

test("runCommand launches npm-style .cmd shims on Windows", { skip: process.platform !== "win32" }, () => {
  // A real executable resolves straight through PATH × PATHEXT.
  assert.equal(runCommand("node", ["--version"]).ok, true);

  // A batch shim like npm's claude.cmd must go through cmd.exe: Node refuses
  // to spawn it (EINVAL), which the doctor used to misreport as "not on PATH".
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "ov-doctor-shim-")));
  const path = `${bin}${delimiter}${process.env.PATH || ""}`;
  writeFileSync(join(bin, "ov-echo-ok.cmd"), "@echo off\r\necho cmd-ok\r\n");
  const result = runCommand("ov-echo-ok", [], { timeoutMs: 10000, env: { ...process.env, PATH: path } });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "cmd-ok");

  // Arguments survive the cmd.exe hop; cmd keeps the quotes on %1, exactly as
  // when the same line is typed into a shell.
  writeFileSync(join(bin, "ov-echo-arg.cmd"), "@echo off\r\necho arg=%1\r\n");
  const argResult = runCommand("ov-echo-arg", ["hello world"], { timeoutMs: 10000, env: { ...process.env, PATH: path } });
  assert.equal(argResult.ok, true);
  assert.equal(argResult.stdout, 'arg="hello world"');

  // An installed-but-unspawnable name still reports "not found", not a crash.
  assert.equal(runCommand("ov-echo-never", [], { timeoutMs: 10000, env: { ...process.env, PATH: path } }).ok, false);
});
