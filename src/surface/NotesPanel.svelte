<script lang="ts">
  import { tick } from "svelte";

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

  type SaveState = "idle" | "dirty" | "saving" | "saved" | "failed";

  const APP = "com.ma-zierl.notes";
  const host = window.appHost;
  let notes = $state<Note[]>([]);
  let selectedId = $state<string | null>(null);
  let title = $state("");
  let body = $state("");
  let tags = $state<string[]>([]);
  let tagDraft = $state("");
  let query = $state("");
  let saveState = $state<SaveState>("idle");
  let message = $state("");
  let ready = $state(false);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let savedVersion = $state<number | null>(null);
  let confirmDelete = $state(false);
  let listOpen = $state(false);
  let revision = 0;
  let saveInFlight = false;
  let externalConflict = $state(false);
  let deleteButton = $state<HTMLButtonElement>();
  let deleteCancelButton = $state<HTMLButtonElement>();
  let deleteConfirmButton = $state<HTMLButtonElement>();

  const selected = $derived(notes.find((note) => note.note_id === selectedId) ?? null);
  const filtered = $derived(notes.filter((note) => {
    const term = query.trim().toLocaleLowerCase("en-US");
    return term === "" || note.title.toLocaleLowerCase("en-US").includes(term)
      || note.body.toLocaleLowerCase("en-US").includes(term)
      || note.tags.some((tag) => tag.includes(term));
  }));

  function completed(outcome: any): any {
    const result = outcome?.result;
    if (result?.kind === "completed") return result.result;
    if (result?.kind === "refused") throw new Error(`Permission required: ${result.reason}`);
    throw new Error(result?.error ?? "The action failed.");
  }

  async function invoke(capability: string, input: Record<string, unknown>): Promise<any> {
    return completed(await host.invoke({ provider: APP, capability }, input, `${capability} note`));
  }

  async function refresh(preferId = selectedId): Promise<void> {
    const result = await invoke("list_tree", {});
    notes = Array.isArray(result?.notes) ? result.notes : [];
    if (preferId && notes.some((note) => note.note_id === preferId)) selectedId = preferId;
  }

  function edit(): void {
    revision += 1;
    saveState = "dirty";
    message = "Draft not saved yet";
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), 700);
  }

  function newNote(): void {
    if (saveState === "dirty" || saveState === "saving" || saveState === "failed") {
      message = "Save or retry this draft before starting another note.";
      return;
    }
    resetNewNote();
  }

  function resetNewNote(): void {
    if (saveTimer) clearTimeout(saveTimer);
    selectedId = null;
    savedVersion = null;
    title = "";
    body = "";
    tags = [];
    tagDraft = "";
    saveState = "idle";
    externalConflict = false;
    message = "New note";
    listOpen = false;
  }

  function select(note: Note): void {
    if (note.note_id !== selectedId && (saveState === "dirty" || saveState === "saving" || saveState === "failed")) {
      message = "Save or retry this draft before opening another note.";
      return;
    }
    if (saveTimer) clearTimeout(saveTimer);
    selectedId = note.note_id;
    savedVersion = note.version;
    title = note.title;
    body = note.body;
    tags = [...note.tags];
    tagDraft = "";
    saveState = "idle";
    externalConflict = note.externally_modified;
    message = note.externally_modified ? "Changed outside Notes" : "Up to date";
    listOpen = false;
  }

  async function save(overwrite = false): Promise<void> {
    if (saveInFlight || (body.trim() === "" && title.trim() === "")) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    saveInFlight = true;
    const submittedRevision = revision;
    const submitted = { title, body, tags: [...tags] };
    saveState = "saving";
    message = "Saving";
    try {
      const result = selectedId
        ? await invoke("write", {
            target: selectedId,
            body: submitted.body,
            title: submitted.title,
            tags: submitted.tags,
            expected_version: savedVersion,
            overwrite_external_change: overwrite,
          })
        : await invoke("create", submitted);
      const note = result?.note as Note;
      selectedId = note.note_id;
      savedVersion = note.version;
      externalConflict = false;
      await refresh(note.note_id);
      if (revision === submittedRevision) {
        saveState = "saved";
        message = "Saved";
        setTimeout(() => {
          if (saveState === "saved" && revision === submittedRevision) {
            saveState = "idle";
            message = "Up to date";
          }
        }, 1400);
      } else {
        saveState = "dirty";
        message = "Saving newer changes";
      }
    } catch (error) {
      saveState = "failed";
      const detail = String((error as Error).message ?? error);
      externalConflict = detail.includes("changed outside Notes");
      message = `Save paused. Draft preserved. ${detail}`;
    } finally {
      saveInFlight = false;
      if (revision !== submittedRevision && saveState !== "failed") {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => void save(), 0);
      }
    }
  }

  async function loadExternalVersion(): Promise<void> {
    if (!selectedId) return;
    try {
      const result = await invoke("read", { target: selectedId });
      revision += 1;
      select(result.note as Note);
    } catch (error) {
      message = `Reload failed. Draft preserved. ${String((error as Error).message ?? error)}`;
    }
  }

  function addTag(): void {
    const normalized = tagDraft.trim().toLocaleLowerCase("en-US").replace(/\s+/g, "-");
    if (!normalized) return;
    if (tags.includes(normalized)) {
      message = `Tag “${normalized}” is already on this note.`;
      tagDraft = "";
      return;
    }
    if (tags.length >= 24) {
      message = "A note can have up to 24 tags.";
      return;
    }
    tags = [...tags, normalized];
    tagDraft = "";
    edit();
  }

  function removeTag(tag: string): void {
    tags = tags.filter((candidate) => candidate !== tag);
    edit();
  }

  function tagKeydown(event: KeyboardEvent): void {
    if ((event.key === "Enter" || event.key === ",") && !event.isComposing) {
      event.preventDefault();
      addTag();
    }
  }

  async function deleteNote(): Promise<void> {
    if (!selectedId) return;
    try {
      await invoke("delete", { target: selectedId });
      closeDeleteDialog();
      resetNewNote();
      await refresh(null);
      message = "Note deleted";
    } catch (error) {
      confirmDelete = false;
      message = `Delete failed. ${String((error as Error).message ?? error)}`;
    }
  }

  async function openDeleteDialog(): Promise<void> {
    confirmDelete = true;
    await tick();
    deleteCancelButton?.focus();
  }

  function closeDeleteDialog(): void {
    confirmDelete = false;
    void tick().then(() => deleteButton?.focus());
  }

  function handleDeleteDialogKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDeleteDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const first = deleteCancelButton;
    const last = deleteConfirmButton;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  $effect(() => {
    host.onInit(async () => {
      ready = true;
      try {
        await refresh(null);
        if (notes.length > 0) select(notes[0]); else resetNewNote();
      } catch (error) {
        message = String((error as Error).message ?? error);
      }
    });
    host.ready();
    return () => { if (saveTimer) clearTimeout(saveTimer); };
  });
</script>

<main class:list-open={listOpen}>
  <aside aria-label="Notes list">
    <div class="list-tools">
      <button class="new" type="button" onclick={newNote}>New note</button>
      <input bind:value={query} type="search" aria-label="Search notes" placeholder="Search notes" />
    </div>
    <button class="list-toggle" type="button" aria-expanded={listOpen} onclick={() => (listOpen = !listOpen)}>
      {listOpen ? "Hide notes" : `Notes (${filtered.length})`}
    </button>
    <div class="note-list">
      {#if !ready}<p>Loading notes…</p>
      {:else if filtered.length === 0}<p>No matching notes.</p>
      {:else}
        {#each filtered as note (note.note_id)}
          <button class:active={note.note_id === selectedId} aria-current={note.note_id === selectedId ? "page" : undefined} onclick={() => select(note)}>
            <strong>{note.title || "Untitled note"}</strong>
            <small>{note.tags.join(" · ") || new Date(note.updated_at).toLocaleDateString()}</small>
          </button>
        {/each}
      {/if}
    </div>
  </aside>

  <section class="editor" aria-labelledby="editor-title">
    <header>
      <input id="editor-title" class="title" bind:value={title} oninput={edit} placeholder="Untitled note" aria-label="Note title" />
      <div class="actions">
        <button type="button" disabled={saveState === "saving"} onclick={() => void save()}>Save</button>
        {#if selectedId}<button bind:this={deleteButton} class="danger" type="button" onclick={() => void openDeleteDialog()}>Delete</button>{/if}
      </div>
    </header>

    <div class="tags" aria-label="Note tags">
      <span class="tag-label">Tags</span>
      {#each tags as tag (tag)}
        <span class="tag">{tag}<button type="button" aria-label={`Remove tag ${tag}`} onclick={() => removeTag(tag)}>×</button></span>
      {/each}
      <input bind:value={tagDraft} onkeydown={tagKeydown} placeholder="Add tag" aria-label="Add tag" maxlength="32" />
      <button class="add-tag" type="button" disabled={!tagDraft.trim()} onclick={addTag}>Add</button>
    </div>

    <div class="status" class:failed={saveState === "failed"} role="status" aria-live="polite">
      <span>{message}</span>
      {#if saveState === "failed"}<button type="button" onclick={() => void save()}>Retry</button>{/if}
      {#if externalConflict || selected?.externally_modified}
        <button type="button" onclick={() => void loadExternalVersion()}>Load file, discard draft</button>
        <button type="button" onclick={() => void save(true)}>Overwrite with draft</button>
      {/if}
    </div>

    <textarea bind:value={body} oninput={edit} aria-label="Note body" placeholder="Write in Markdown…" spellcheck="true"></textarea>
  </section>

  {#if confirmDelete}
    <div class="backdrop" role="presentation">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title" tabindex="-1" onkeydown={handleDeleteDialogKeydown}>
        <h2 id="delete-title">Delete this note?</h2>
        <p>This permanently deletes “{title || "Untitled note"}”.</p>
        <div class="dialog-actions">
          <button bind:this={deleteCancelButton} type="button" onclick={closeDeleteDialog}>Keep note</button>
          <button bind:this={deleteConfirmButton} class="danger" type="button" onclick={() => void deleteNote()}>Delete note</button>
        </div>
      </div>
    </div>
  {/if}
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(html), :global(body) { margin: 0; min-height: 100%; }
  :global(body) { font: 0.95rem/1.5 ui-sans-serif, system-ui, sans-serif; background: #f5f1e8; color: #27231d; }
  button, input, textarea { font: inherit; }
  button { min-height: 2rem; border: 1px solid #b8ad9c; border-radius: 0.55rem; background: #fffdf8; color: inherit; padding: 0.35rem 0.7rem; cursor: pointer; }
  button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 3px solid #9d5d2e; outline-offset: 2px; }
  button:disabled { opacity: 0.55; cursor: default; }
  main { min-height: min(76dvh, 54rem); display: grid; grid-template-columns: minmax(13rem, 18rem) minmax(0, 1fr); background: #fffdf8; }
  aside { min-width: 0; border-right: 1px solid #d8cfc0; background: #eee7da; display: flex; flex-direction: column; }
  .list-tools { display: grid; gap: 0.55rem; padding: 0.8rem; }
  .new { background: #623b25; color: #fffaf2; border-color: #623b25; font-weight: 700; }
  .list-tools input { width: 100%; min-width: 0; border: 1px solid #c8bdad; border-radius: 0.55rem; background: #fffdf8; padding: 0.5rem 0.65rem; }
  .list-toggle { display: none; }
  .note-list { min-height: 0; overflow-y: auto; display: grid; align-content: start; gap: 0.2rem; padding: 0 0.45rem 0.7rem; }
  .note-list > button { min-width: 0; display: grid; gap: 0.1rem; text-align: left; border-color: transparent; background: transparent; padding: 0.65rem; }
  .note-list > button.active { background: #fffdf8; border-color: #c8bdad; }
  .note-list strong, .note-list small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note-list small { color: #706558; }
  .note-list p { padding: 0 0.5rem; color: #706558; }
  .editor { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto auto 3.25rem minmax(18rem, 1fr); }
  header { min-width: 0; display: flex; align-items: center; gap: 0.7rem; padding: 0.7rem 1rem; border-bottom: 1px solid #e4ddd2; }
  .title { min-width: 0; flex: 1; border: none; background: transparent; color: inherit; font: 700 clamp(1.05rem, 0.98rem + 0.35vw, 1.3rem)/1.3 ui-serif, Georgia, serif; padding: 0.35rem; }
  .actions, .dialog-actions { display: flex; flex-wrap: wrap; gap: 0.45rem; }
  .danger { color: #8a2525; border-color: #d9a4a0; background: #fff2f0; }
  .tags { min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 0.35rem; padding: 0.5rem 1rem; border-bottom: 1px solid #e4ddd2; background: #faf6ee; }
  .tag-label { color: #706558; font-size: 0.8rem; font-weight: 700; }
  .tag { display: inline-flex; align-items: center; gap: 0.2rem; border-radius: 999px; background: #ead8c6; padding: 0.15rem 0.25rem 0.15rem 0.55rem; font-size: 0.8rem; }
  .tag button { min-width: 1.5rem; min-height: 1.5rem; border: none; border-radius: 50%; background: transparent; padding: 0; }
  .tags input { min-width: 6rem; flex: 1; border: none; background: transparent; padding: 0.35rem; }
  .add-tag { min-height: 1.8rem; padding-block: 0.2rem; }
  .status { min-width: 0; height: 3.25rem; overflow: auto; display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; padding: 0.4rem 1rem; color: #706558; font-size: 0.82rem; border-bottom: 1px solid #e4ddd2; }
  .status span { min-width: 0; flex: 1; overflow-wrap: anywhere; }
  .status.failed { color: #8a2525; background: #fff2f0; }
  textarea { width: 100%; min-width: 0; min-height: 0; resize: none; overflow: auto; border: none; background: #fffdf8; color: inherit; padding: clamp(1rem, 0.7rem + 1.2vw, 2rem); font: 1rem/1.65 ui-monospace, "Cascadia Code", monospace; }
  .backdrop { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; padding: 1rem; background: #27231dcc; }
  .dialog { width: min(100%, 28rem); border-radius: 0.85rem; background: #fffdf8; padding: 1.2rem; box-shadow: 0 1rem 3rem #27231d55; }
  .dialog h2 { margin: 0; font: 700 1.2rem/1.3 ui-serif, Georgia, serif; }
  .dialog p { margin: 0.6rem 0 1rem; }
  .dialog-actions { justify-content: flex-end; }
  @media (prefers-color-scheme: dark) {
    :global(body), main, textarea, .dialog { background: #211e19; color: #eee7da; }
    aside { background: #181611; border-color: #4b443a; }
    button, .list-tools input { background: #2a261f; border-color: #5c5347; color: inherit; }
    .new { background: #b36f3d; border-color: #b36f3d; color: #17130f; }
    .note-list > button.active, .tags { background: #2a261f; border-color: #5c5347; }
    header, .tags, .status { border-color: #4b443a; }
    .tag { background: #513824; }
    .status.failed, .danger { color: #ffc2ba; background: #462522; border-color: #81504a; }
    .backdrop { background: #000b; }
  }
  @media (max-width: 42em) {
    main { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(32rem, 1fr); }
    aside { border-right: none; border-bottom: 1px solid #d8cfc0; }
    .list-tools { grid-template-columns: auto minmax(0, 1fr); }
    .list-toggle { display: block; margin: 0 0.8rem 0.6rem; }
    .note-list { display: none; max-height: 12rem; }
    main.list-open .note-list { display: grid; }
    header { align-items: flex-start; }
  }
  @media (max-width: 25em) {
    .list-tools { grid-template-columns: minmax(0, 1fr); }
    header { flex-wrap: wrap; }
    .title { flex-basis: 100%; }
  }
  @media (prefers-reduced-motion: reduce) { :global(*) { scroll-behavior: auto !important; } }
</style>
