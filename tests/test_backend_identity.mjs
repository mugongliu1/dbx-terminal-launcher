import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const binary = process.argv[2] || path.join(root, "backend", "target", "x86_64-pc-windows-gnu", "release", "dbx-plugin-dbx-terminal-launcher.exe");
const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });

try {
  const response = await new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timeout = setTimeout(() => reject(new Error("Plugin initialization timed out")), 5000);
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      try { resolve(JSON.parse(output.slice(0, newline))); }
      catch (error) { reject(error); }
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`Plugin exited ${code}: ${errors}`)));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "plugin/initialize", params: { host: { protocolVersions: [1] } } }) + "\n");
  });
  assert.equal(response.result.plugin.id, manifest.id);
  assert.equal(response.result.plugin.version, manifest.version);
  console.log(`PASS: backend identity ${manifest.id}/${manifest.version}`);
} finally {
  child.kill();
}
