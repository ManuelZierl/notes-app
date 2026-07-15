import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function startServer(dataDirectory) {
  const child = spawn(process.execPath, [join(here, "..", "dist", "backend", "server.mjs")], {
    env: { ...process.env, APP_HOST_DATA_DIR: dataDirectory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    responses.get(message.id)?.(message);
    responses.delete(message.id);
  });
  let id = 0;
  return {
    request(method, params = {}) {
      id += 1;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 3000);
        responses.set(id, (message) => {
          clearTimeout(timeout);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    close() {
      lines.close();
      child.stdin.end();
    },
  };
}

test("old metadata without tags loads and gains tags on save", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "notes-app-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const body = "# Existing note\n\nPreserved body.";
  await writeFile(join(root, "existing.md"), body, "utf8");
  await writeFile(join(root, "existing.md.meta.json"), JSON.stringify({
    note_id: "note-existing",
    version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    content_sha256: digest(body),
    comments: [{ comment_id: "comment-1", text: "Keep this" }],
    created_run_id: "run-created",
    updated_run_id: "run-updated",
    created_by: "notes",
    updated_by: "chat",
  }, null, 2), "utf8");

  const server = startServer(root);
  context.after(() => server.close());
  await server.request("initialize", { protocolVersion: "2025-06-18" });
  const listed = await server.request("tools/call", { name: "list_tree", arguments: {} });
  assert.deepEqual(listed.structuredContent.notes[0].tags, []);

  const written = await server.request("tools/call", {
    name: "write",
    arguments: {
      target: "note-existing",
      body,
      tags: ["project"],
      expected_version: 1,
      overwrite_external_change: false,
    },
  });
  assert.deepEqual(written.structuredContent.note.tags, ["project"]);
  const metadata = JSON.parse(await readFile(join(root, "existing.md.meta.json"), "utf8"));
  assert.deepEqual(metadata.tags, ["project"]);
  assert.deepEqual(metadata.comments, [{ comment_id: "comment-1", text: "Keep this" }]);
  assert.equal(metadata.created_run_id, "run-created");
  assert.equal(metadata.updated_by, "chat");
  assert.equal(await readFile(join(root, "existing.md"), "utf8"), body);
});

test("committed legacy transaction is completed before serving requests", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "notes-app-recovery-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const body = "# Recovered";
  const metadata = {
    note_id: "note-recovered",
    version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    content_sha256: digest(body),
    tags: ["recovered"],
  };
  await writeFile(join(root, ".ai-app-host-notes-transaction.json"), JSON.stringify({
    version: 1,
    transaction_id: "transaction-1",
    phase: "committed",
    mutations: [
      { relative_path: "recovered.md", before: null, after: body },
      { relative_path: "recovered.md.meta.json", before: null, after: JSON.stringify(metadata, null, 2) },
    ],
  }), "utf8");

  const server = startServer(root);
  context.after(() => server.close());
  await server.request("initialize", { protocolVersion: "2025-06-18" });
  const listed = await server.request("tools/call", { name: "list_tree", arguments: {} });
  assert.equal(listed.structuredContent.notes[0].note_id, "note-recovered");
  await assert.rejects(readFile(join(root, ".ai-app-host-notes-transaction.json"), "utf8"), /ENOENT/);
});

test("built package declares only the external identity and valid asset hashes", async () => {
  const dist = join(here, "..", "dist");
  const app = JSON.parse(await readFile(join(dist, "app.json"), "utf8"));
  assert.equal(app.id, "com.ma-zierl.notes");
  assert.equal(app.backend.kind, "mcp-stdio");
  assert.equal(app.manifest.surfaces[0].ui.entry, "ui/index.html");
  assert.equal(app.consumer_grant_requests.every((entry) => entry.holder === "chat" && entry.request.scope.provider === app.id), true);
  for (const [asset, expected] of Object.entries(app.integrity.assets)) {
    const bytes = await readFile(join(dist, asset));
    const actual = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
    assert.equal(actual, expected, asset);
  }
});
