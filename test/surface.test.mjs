import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("surface follows the host-provided theme", async () => {
  const html = await readFile(new URL("../dist/ui/index.html", import.meta.url), "utf8");
  assert.match(html, /html\[data-theme=["']?dark/);
  assert.doesNotMatch(html, /prefers-color-scheme:\s*dark/);
});
