import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { compile } from "svelte/compiler";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "src");
const dist = join(here, "dist");

const sveltePlugin = {
  name: "svelte",
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, async (args) => {
      const input = await readFile(args.path, "utf8");
      const { js, warnings } = compile(input, { filename: args.path, generate: "client", css: "injected", runes: true });
      for (const warning of warnings) console.warn(`svelte: ${warning.message}`);
      return { contents: js.code, loader: "js" };
    });
  },
};

function sha256(value) {
  return `sha256-${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function capability(name, description, input_schema, effect) {
  return { name, description, input_schema, effect };
}

const emptySchema = { type: "object", properties: {}, additionalProperties: false };
const targetSchema = {
  type: "object",
  properties: { target: { type: "string", minLength: 1 } },
  required: ["target"],
  additionalProperties: false,
};
const tagSchema = { type: "array", items: { type: "string", minLength: 1, maxLength: 32 }, maxItems: 24 };
const commentsSchema = {
  type: "array",
  maxItems: 200,
  items: {
    type: "object",
    properties: {
      comment_id: { type: "string", minLength: 1 },
      text: { type: "string", minLength: 1, maxLength: 4000 },
      selected_text: { type: "string", minLength: 1 },
      selection_start: { type: "integer", minimum: 0 },
      selection_end: { type: "integer", minimum: 1 },
      context_before: { type: "string" },
      context_after: { type: "string" },
      created_at: { type: "string" },
    },
    required: ["comment_id", "text", "selected_text", "selection_start", "selection_end", "context_before", "context_after", "created_at"],
    additionalProperties: false,
  },
};

function grant(holder, capabilityName, condition, reason) {
  return {
    ...(holder ? { holder } : {}),
    scope: { kind: "exact-capability", provider: "com.ma-zierl.notes", capability: capabilityName },
    data_scope: { kind: "none" },
    condition,
    reason,
    duration: { kind: "non-expiring" },
  };
}

function manifest(indexHtml, backend) {
  const capabilities = [
    capability("create", "Create a Markdown note", {
      type: "object",
      properties: { path: { type: "string", minLength: 1 }, title: { type: "string" }, body: { type: "string" }, tags: tagSchema, comments: commentsSchema },
      required: ["body"],
      additionalProperties: false,
    }, "local-write"),
    capability("list_tree", "List notes in the workspace", emptySchema, "read-only"),
    capability("read", "Read a note", targetSchema, "read-only"),
    capability("write", "Write a Markdown note", {
      type: "object",
      properties: {
        target: { type: "string", minLength: 1 }, title: { type: "string" }, body: { type: "string" }, tags: tagSchema, comments: commentsSchema,
        expected_version: { type: ["integer", "null"], minimum: 1 }, overwrite_external_change: { type: "boolean" },
      },
      required: ["target", "body"],
      additionalProperties: false,
    }, "local-write"),
    capability("rename", "Rename a note file", {
      type: "object",
      properties: { target: { type: "string", minLength: 1 }, path: { type: "string", minLength: 1 } },
      required: ["target", "path"],
      additionalProperties: false,
    }, "local-write"),
    capability("delete", "Delete a note", targetSchema, "destructive"),
    capability("search", "Search note titles, bodies, tags, and comments", {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    }, "read-only"),
  ];
  const selfGrants = [
    grant(null, "create", "notify", "Create notes from the Notes editor."),
    grant(null, "list_tree", "silent", "List notes to render the Notes workspace."),
    grant(null, "read", "silent", "Read a selected note."),
    grant(null, "write", "notify", "Save edits made in the Notes editor."),
    grant(null, "rename", "notify", "Rename note files."),
    grant(null, "delete", "requires-approval", "Delete a note only after trusted host approval."),
    grant(null, "search", "silent", "Search notes in the Notes workspace."),
  ];
  return {
    format_version: 1,
    id: "com.ma-zierl.notes",
    version: "0.2.1",
    display_name: "Notes",
    description: "A local Markdown workspace with tags, comments, and autosave.",
    publisher: { name: "Manuel Zierl" },
    license: "MIT",
    min_host_version: "0.1.0-alpha.1",
    manifest: {
      capabilities,
      surfaces: [{
        name: "notes",
        kind: "panel",
        title: "Notes",
        description: "Write and organize local Markdown notes.",
        intents: capabilities.map(({ name }) => ({ provider: "com.ma-zierl.notes", capability: name })),
        ui: { entry: "ui/index.html" },
      }],
      grant_requests: selfGrants,
    },
    consumer_grant_requests: [
      { holder: "chat", request: grant(null, "list_tree", "silent", "Let Chat list notes when the user asks.") },
      { holder: "chat", request: grant(null, "search", "silent", "Let Chat search notes when the user asks.") },
      { holder: "chat", request: grant(null, "read", "silent", "Let Chat read a note selected by the user request.") },
      { holder: "chat", request: grant(null, "create", "notify", "Let Chat create a note when the user asks it to remember something.") },
      { holder: "chat", request: grant(null, "write", "requires-approval", "Let Chat edit a note only after approval.") },
      { holder: "chat", request: grant(null, "delete", "requires-approval", "Let Chat delete a note only after approval.") },
    ],
    backend: { kind: "mcp-stdio", authority_mode: "unsandboxed", command: "node", args: ["backend/server.mjs"] },
    integrity: { algorithm: "sha256", assets: { "ui/index.html": sha256(indexHtml), "backend/server.mjs": sha256(backend) } },
  };
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(join(dist, "ui"), { recursive: true });
  await mkdir(join(dist, "backend"), { recursive: true });
  const [surfaceBuild, backendBuild] = await Promise.all([
    esbuild.build({ entryPoints: [join(source, "surface", "main.ts")], bundle: true, format: "iife", platform: "browser", target: "es2022", write: false, plugins: [sveltePlugin] }),
    esbuild.build({ entryPoints: [join(source, "backend", "server.ts")], bundle: true, format: "esm", platform: "node", target: "node18", write: false }),
  ]);
  const script = surfaceBuild.outputFiles[0].text;
  const indexHtml = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body><script>${script}</script></html>\n`;
  const backend = backendBuild.outputFiles[0].text;
  await Promise.all([
    writeFile(join(dist, "ui", "index.html"), indexHtml, "utf8"),
    writeFile(join(dist, "backend", "server.mjs"), backend, "utf8"),
    writeFile(join(dist, "app.json"), `${JSON.stringify(manifest(indexHtml, backend), null, 2)}\n`, "utf8"),
  ]);
}

main().catch((error) => { console.error(error); process.exit(1); });
