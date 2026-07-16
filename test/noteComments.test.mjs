import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

// The anchor helper is a TypeScript surface module; bundle it with the same
// toolchain the build uses and import the result for direct unit testing.
const source = fileURLToPath(new URL("../src/surface/noteComments.ts", import.meta.url));
const bundled = await esbuild.build({ entryPoints: [source], bundle: true, format: "esm", write: false });
const { locateNoteComment } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

function comment(overrides = {}) {
  return {
    comment_id: "comment-1",
    text: "Remember this",
    selected_text: "selected text",
    selection_start: 7,
    selection_end: 20,
    context_before: "Before ",
    context_after: " after.",
    created_at: "2026-07-14T10:00:00Z",
    ...overrides,
  };
}

test("keeps the stored offsets while they still quote the commented text", () => {
  const body = "Before selected text after.";
  assert.deepEqual(locateNoteComment(body, comment()), { from: 7, to: 20 });
});

test("relocates a quoted passage after nearby edits", () => {
  const body = "Intro added. Before selected text after.";
  assert.deepEqual(locateNoteComment(body, comment()), { from: 20, to: 33 });
});

test("does not guess when an edited anchor matches repeated text", () => {
  const body = "selected text, then selected text";
  assert.equal(locateNoteComment(body, comment({
    selection_start: 1,
    selection_end: 14,
    context_before: "old ",
    context_after: " context",
  })), null);
});

test("returns null when the quoted text left the note entirely", () => {
  assert.equal(locateNoteComment("Something else entirely.", comment()), null);
});
