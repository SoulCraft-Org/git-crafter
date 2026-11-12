// Helpers every collector can import: running a command, and the measured and
// could_not_check result rows. Node built-ins only, no package import, so a
// collector that runs where node_modules is missing (the Pages action's
// two-page collect) still loads (issue #715). code-util.mjs re-exports them.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

// Runs one command with no shell and resolves, never rejects, with its output,
// exit code and time; missing is true when the command is not on PATH.
export function runCommand(cmd, args, { cwd, timeoutMs = 600_000, env = {}, input } = {}) {
  return new Promise((done) => {
    const started = performance.now();
    const chunks = [];
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks);
      done({ stdout: bytes.toString("utf8"), bytes, stderr, ms: performance.now() - started, ...result });
    };
    // spawn reports a missing cwd as ENOENT too, which would read as a
    // missing command.
    if (cwd && !isDir(cwd)) return finish({ code: null, stderr: `no such folder: ${cwd}` });
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...env },
      stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    if (input != null) {
      child.stdin.on("error", () => {}); // a child that exits early closes its stdin
      child.stdin.end(input);
    }
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => finish({ code: null, missing: err.code === "ENOENT", stderr: stderr || err.message }));
    child.on("close", (code, signal) => finish({ code, timedOut: signal === "SIGTERM" }));
  });
}

// A measured metric with its source, detail rows when given, and read time.
export function measured(value, source, detail) {
  return { value, ...(detail ? { detail } : {}), source, read_at: new Date().toISOString() };
}

// A could_not_check metric with its reason and source.
export function unknown(reason, source) {
  return { could_not_check: reason, source };
}

// A command output's first meaningful line, cut to 200 characters.
export function firstLine(text) {
  return (text ?? "").trim().split("\n").find((l) => l.trim() && !/^[=\s]+$/.test(l))?.slice(0, 200) ?? "no output";
}

// True when the path is a folder.
export function isDir(path) {
  return existsSync(path) && statSync(path).isDirectory();
}
