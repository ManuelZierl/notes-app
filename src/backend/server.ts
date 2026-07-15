import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const APP_ID = "com.ma-zierl.notes";
const SERVER_INFO = { name: APP_ID, version: "0.1.0" };
const PROTOCOL_VERSION = "2025-06-18";
const dataDirectory = process.env.APP_HOST_DATA_DIR;
if (!dataDirectory) throw new Error("APP_HOST_DATA_DIR is required");
const ROOT = resolve(dataDirectory);
mkdirSync(ROOT, { recursive: true });
const TRANSACTION_FILE = ".ai-app-host-notes-transaction.json";

interface Metadata {
  note_id: string;
  title?: string;
  version: number;
  created_at: string;
  updated_at: string;
  content_sha256: string;
  tags: string[];
  comments?: unknown[];
  created_run_id?: string;
  updated_run_id?: string;
  created_by?: string;
  updated_by?: string;
}

interface FileMutation {
  relative_path: string;
  before: string | null;
  after: string | null;
}

interface NotesTransaction {
  version: 1;
  transaction_id: string;
  phase: "prepared" | "committed";
  mutations: FileMutation[];
}

interface Note {
  note_id: string;
  path: string;
  title: string;
  body: string;
  tags: string[];
  version: number;
  created_at: string;
  updated_at: string;
  externally_modified: boolean;
}

interface JsonRpcRequest {
  id?: number | string;
  method: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
}

const emptySchema = { type: "object", properties: {}, additionalProperties: false };
const targetSchema = {
  type: "object",
  properties: { target: { type: "string", minLength: 1 } },
  required: ["target"],
  additionalProperties: false,
};
const TOOLS = [
  {
    name: "create",
    description: "Create a Markdown note",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        title: { type: "string" },
        body: { type: "string" },
        tags: { type: "array", items: { type: "string", minLength: 1, maxLength: 32 }, maxItems: 24 },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  { name: "list_tree", description: "List notes in the workspace", inputSchema: emptySchema },
  { name: "read", description: "Read a note", inputSchema: targetSchema },
  {
    name: "write",
    description: "Write a Markdown note",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", minLength: 1 },
        title: { type: "string" },
        body: { type: "string" },
        tags: { type: "array", items: { type: "string", minLength: 1, maxLength: 32 }, maxItems: 24 },
        expected_version: { type: ["integer", "null"], minimum: 1 },
        overwrite_external_change: { type: "boolean" },
      },
      required: ["target", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "rename",
    description: "Rename a note file",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string", minLength: 1 }, path: { type: "string", minLength: 1 } },
      required: ["target", "path"],
      additionalProperties: false,
    },
  },
  { name: "delete", description: "Delete a note", inputSchema: targetSchema },
  {
    name: "search",
    description: "Search note titles, bodies, and tags",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
] as const;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("note path must be a relative path without traversal");
  }
  const path = resolve(ROOT, normalized);
  if (path !== ROOT && !path.startsWith(`${ROOT}${sep}`)) throw new Error("note path escaped the workspace");
  ensureSafeAncestors(path);
  return path;
}

function ensureSafeAncestors(path: string): void {
  if (lstatSync(ROOT).isSymbolicLink()) throw new Error("notes data directory must not be a symbolic link");
  const parts = relative(ROOT, path).split(sep).slice(0, -1);
  let current = ROOT;
  for (const part of parts) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`symbolic-link path component is not allowed: '${relative(ROOT, current)}'`);
    }
  }
}

function ensureMarkdownPath(value: string): string {
  const withExtension = extname(value) === "" ? `${value}.md` : value;
  if (extname(withExtension).toLocaleLowerCase("en-US") !== ".md") throw new Error("note paths must end in .md");
  return safePath(withExtension);
}

function sidecar(path: string): string {
  return `${path}.meta.json`;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, "utf8");
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function transactionPath(): string {
  return join(ROOT, TRANSACTION_FILE);
}

function mutation(path: string, after: string | null): FileMutation {
  ensureSafeAncestors(path);
  return {
    relative_path: relative(ROOT, path).replaceAll("\\", "/"),
    before: existsSync(path) ? readFileSync(path, "utf8") : null,
    after,
  };
}

function applyImages(mutations: FileMutation[], after: boolean): void {
  for (const item of mutations) {
    const path = safePath(item.relative_path);
    const image = after ? item.after : item.before;
    if (image === null) rmSync(path, { force: true });
    else atomicWrite(path, image);
  }
}

function persistTransaction(transaction: NotesTransaction): void {
  atomicWrite(transactionPath(), `${JSON.stringify(transaction, null, 2)}\n`);
}

function commitMutations(mutations: FileMutation[]): void {
  reconcileTransaction();
  const transaction: NotesTransaction = {
    version: 1,
    transaction_id: randomUUID(),
    phase: "prepared",
    mutations,
  };
  persistTransaction(transaction);
  transaction.phase = "committed";
  persistTransaction(transaction);
  applyImages(mutations, true);
  rmSync(transactionPath());
}

function reconcileTransaction(): void {
  if (!existsSync(transactionPath())) return;
  let transaction: NotesTransaction;
  try {
    transaction = JSON.parse(readFileSync(transactionPath(), "utf8")) as NotesTransaction;
  } catch (error) {
    throw new Error(`parse notes transaction journal failed; preserved '${transactionPath()}': ${String((error as Error).message ?? error)}`);
  }
  if (transaction.version !== 1 || !Array.isArray(transaction.mutations)
    || (transaction.phase !== "prepared" && transaction.phase !== "committed")) {
    throw new Error(`unsupported notes transaction journal '${transactionPath()}'`);
  }
  if (transaction.phase === "committed") applyImages(transaction.mutations, true);
  rmSync(transactionPath());
}

reconcileTransaction();

function parseMetadata(path: string): Metadata {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(sidecar(path), "utf8"));
  } catch (error) {
    throw new Error(`parse note metadata failed; preserved '${sidecar(path)}': ${String((error as Error).message ?? error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`invalid note metadata '${sidecar(path)}'`);
  const value = raw as Record<string, unknown>;
  const requiredStrings = ["note_id", "created_at", "updated_at", "content_sha256"] as const;
  for (const field of requiredStrings) {
    if (typeof value[field] !== "string" || value[field] === "") throw new Error(`invalid note metadata '${sidecar(path)}': ${field} is required`);
  }
  if (!Number.isInteger(value.version) || Number(value.version) < 1) throw new Error(`invalid note metadata '${sidecar(path)}': version is required`);
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string"))) {
    throw new Error(`invalid note metadata '${sidecar(path)}': tags must be strings`);
  }
  return {
    note_id: value.note_id as string,
    title: typeof value.title === "string" ? value.title : undefined,
    version: value.version as number,
    created_at: value.created_at as string,
    updated_at: value.updated_at as string,
    content_sha256: value.content_sha256 as string,
    tags: value.tags === undefined ? [] : [...(value.tags as string[])],
    comments: Array.isArray(value.comments) ? value.comments : undefined,
    created_run_id: typeof value.created_run_id === "string" ? value.created_run_id : undefined,
    updated_run_id: typeof value.updated_run_id === "string" ? value.updated_run_id : undefined,
    created_by: typeof value.created_by === "string" ? value.created_by : undefined,
    updated_by: typeof value.updated_by === "string" ? value.updated_by : undefined,
  };
}

function titleFromBody(path: string, body: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || relative(ROOT, path).replaceAll("\\", "/").replace(/\.md$/i, "");
}

function readNote(path: string): Note {
  if (lstatSync(path).isSymbolicLink() || lstatSync(sidecar(path)).isSymbolicLink()) throw new Error("symbolic links are not notes");
  const body = readFileSync(path, "utf8");
  const metadata = parseMetadata(path);
  return {
    note_id: metadata.note_id,
    path: relative(ROOT, path).replaceAll("\\", "/"),
    title: titleFromBody(path, body, metadata.title),
    body,
    tags: metadata.tags,
    version: metadata.version,
    created_at: metadata.created_at,
    updated_at: metadata.updated_at,
    externally_modified: digest(body) !== metadata.content_sha256,
  };
}

function markdownFiles(directory = ROOT): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.isFile() && extname(entry.name).toLocaleLowerCase("en-US") === ".md") files.push(path);
  }
  return files;
}

function listNotes(): Note[] {
  return markdownFiles().map(readNote).sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.path.localeCompare(right.path));
}

function resolveTarget(target: string): string {
  if (target.startsWith("note-")) {
    const note = listNotes().find((candidate) => candidate.note_id === target);
    if (note) return safePath(note.path);
  }
  const path = ensureMarkdownPath(target);
  if (!existsSync(path)) throw new Error(`unknown note '${target}'`);
  return path;
}

function normalizedTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("tags must be an array");
  const tags = value.map((tag) => String(tag).trim().toLocaleLowerCase("en-US").replace(/\s+/g, "-")).filter(Boolean);
  if (tags.length > 24 || tags.some((tag) => tag.length > 32)) throw new Error("tags exceed the declared limits");
  return [...new Set(tags)];
}

function createNote(args: Record<string, unknown>): Note {
  const body = String(args.body ?? "");
  const title = String(args.title ?? "").trim();
  const fallback = title.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `note-${Date.now()}`;
  const path = ensureMarkdownPath(String(args.path ?? `${fallback}.md`));
  if (existsSync(path)) throw new Error(`note already exists '${relative(ROOT, path)}'`);
  const now = new Date().toISOString();
  const metadata: Metadata = {
    note_id: `note-${randomUUID()}`,
    title,
    version: 1,
    created_at: now,
    updated_at: now,
    content_sha256: digest(body),
    tags: normalizedTags(args.tags),
  };
  commitMutations([
    mutation(path, body),
    mutation(sidecar(path), `${JSON.stringify(metadata, null, 2)}\n`),
  ]);
  return readNote(path);
}

function writeNote(args: Record<string, unknown>): Note {
  const path = resolveTarget(String(args.target ?? ""));
  const metadata = parseMetadata(path);
  if (args.expected_version !== undefined && args.expected_version !== null && Number(args.expected_version) !== metadata.version) {
    throw new Error(`note version conflict: expected ${String(args.expected_version)}, current ${metadata.version}`);
  }
  const currentBody = readFileSync(path, "utf8");
  if (!args.overwrite_external_change && digest(currentBody) !== metadata.content_sha256) {
    throw new Error("note changed outside Notes; reload or explicitly overwrite it");
  }
  const body = String(args.body ?? "");
  const next: Metadata = {
    ...metadata,
    title: typeof args.title === "string" ? args.title.trim() : metadata.title,
    version: metadata.version + 1,
    updated_at: new Date().toISOString(),
    content_sha256: digest(body),
    tags: args.tags === undefined ? metadata.tags : normalizedTags(args.tags),
  };
  commitMutations([
    mutation(path, body),
    mutation(sidecar(path), `${JSON.stringify(next, null, 2)}\n`),
  ]);
  return readNote(path);
}

function renameNote(args: Record<string, unknown>): Note {
  const source = resolveTarget(String(args.target ?? ""));
  const destination = ensureMarkdownPath(String(args.path ?? ""));
  if (existsSync(destination)) throw new Error(`note already exists '${relative(ROOT, destination)}'`);
  const body = readFileSync(source, "utf8");
  const metadata = readFileSync(sidecar(source), "utf8");
  commitMutations([
    mutation(destination, body),
    mutation(sidecar(destination), metadata),
    mutation(source, null),
    mutation(sidecar(source), null),
  ]);
  return readNote(destination);
}

function callTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "create": return { created: true, note: createNote(args) };
    case "list_tree": {
      const notes = listNotes();
      return { notes, total: notes.length };
    }
    case "read": return { note: readNote(resolveTarget(String(args.target ?? ""))) };
    case "write": return { updated: true, note: writeNote(args) };
    case "rename": return { renamed: true, note: renameNote(args) };
    case "delete": {
      const path = resolveTarget(String(args.target ?? ""));
      const note = readNote(path);
      commitMutations([mutation(path, null), mutation(sidecar(path), null)]);
      return { deleted: true, note_id: note.note_id };
    }
    case "search": {
      const query = String(args.query ?? "").toLocaleLowerCase("en-US");
      const notes = listNotes().filter((note) => note.title.toLocaleLowerCase("en-US").includes(query)
        || note.body.toLocaleLowerCase("en-US").includes(query)
        || note.tags.some((tag) => tag.includes(query)));
      return { query: String(args.query ?? ""), notes, total: notes.length };
    }
    default: throw new Error(`unknown tool '${name}'`);
  }
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function handle(request: JsonRpcRequest): void {
  if (request.id === undefined) return;
  const { id, method, params } = request;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
  } else if (method === "ping") {
    send({ id, result: {} });
  } else if (method === "tools/list") {
    send({ id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    try {
      const data = callTool(String(params?.name ?? ""), params?.arguments ?? {});
      send({ id, result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } });
    } catch (error) {
      send({ id, error: { code: -32602, message: String((error as Error).message ?? error) } });
    }
  } else {
    send({ id, error: { code: -32601, message: `method '${method}' not found` } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  try { handle(JSON.parse(line) as JsonRpcRequest); }
  catch (error) { process.stderr.write(`invalid JSON-RPC request: ${String((error as Error).message ?? error)}\n`); }
});
lines.on("close", () => process.exit(0));
