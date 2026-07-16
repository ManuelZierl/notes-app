<script lang="ts">
  import { tick } from "svelte";
  import { locateNoteComment, type NoteComment } from "./noteComments";

  interface Note {
    note_id: string;
    path: string;
    title: string;
    body: string;
    tags: string[];
    comments: NoteComment[];
    version: number;
    created_at: string;
    updated_at: string;
    externally_modified: boolean;
  }

  interface TextSelection {
    from: number;
    to: number;
    text: string;
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
  let tagFilter = $state<string[]>([]);
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
  let bodyInput = $state<HTMLTextAreaElement>();
  let bodyBackdrop = $state<HTMLDivElement>();
  let comments = $state<NoteComment[]>([]);
  let selection = $state<TextSelection | null>(null);
  let commentComposerOpen = $state(false);
  let commentComposerInput = $state<HTMLTextAreaElement>();
  // Snapshot of the selection the composer was opened for, so typing the
  // comment cannot silently retarget it.
  let commentTarget = $state<TextSelection | null>(null);
  let commentDraft = $state("");
  let commentsOpen = $state(false);
  let activeCommentId = $state<string | null>(null);
  let editingCommentId = $state<string | null>(null);
  let editingCommentText = $state("");

  interface BodySegment {
    text: string;
    commentId: string | null;
  }

  // The note body with each anchored comment range marked. Rendered as a
  // transparent-text backdrop behind the textarea so commented passages are
  // highlighted in place, like the old CodeMirror decorations.
  const bodySegments = $derived.by<BodySegment[]>(() => {
    const anchored = comments
      .flatMap((comment) => {
        const range = locateNoteComment(body, comment);
        return range ? [{ id: comment.comment_id, ...range }] : [];
      })
      .sort((left, right) => left.from - right.from);
    const segments: BodySegment[] = [];
    let cursor = 0;
    for (const range of anchored) {
      if (range.to <= cursor) continue; // swallowed by an overlapping mark
      const start = Math.max(range.from, cursor);
      if (start > cursor) segments.push({ text: body.slice(cursor, start), commentId: null });
      segments.push({ text: body.slice(start, range.to), commentId: range.id });
      cursor = range.to;
    }
    if (cursor < body.length) segments.push({ text: body.slice(cursor), commentId: null });
    return segments;
  });

  const selected = $derived(notes.find((note) => note.note_id === selectedId) ?? null);
  const allTags = $derived([...new Set(notes.flatMap((note) => note.tags))].sort());
  // Self-healing: a filtered tag whose last note vanished stops filtering
  // instead of silently hiding everything behind an invisible chip.
  const activeTagFilter = $derived(tagFilter.filter((tag) => allTags.includes(tag)));
  const filtered = $derived(notes.filter((note) => {
    const term = query.trim().toLocaleLowerCase("en-US");
    return activeTagFilter.every((tag) => note.tags.includes(tag))
      && (term === "" || note.title.toLocaleLowerCase("en-US").includes(term)
        || note.body.toLocaleLowerCase("en-US").includes(term)
        || note.tags.some((tag) => tag.includes(term))
        || note.comments.some((comment) => comment.text.toLocaleLowerCase("en-US").includes(term)
          || comment.selected_text.toLocaleLowerCase("en-US").includes(term)));
  }));

  function toggleTagFilter(tag: string): void {
    tagFilter = activeTagFilter.includes(tag)
      ? activeTagFilter.filter((candidate) => candidate !== tag)
      : [...activeTagFilter, tag];
  }

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
    // Tolerate notes from a pre-comments backend still running.
    notes = (Array.isArray(result?.notes) ? (result.notes as Note[]) : [])
      .map((note) => ({ ...note, comments: Array.isArray(note.comments) ? note.comments : [] }));
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

  function resetCommentUi(): void {
    selection = null;
    commentComposerOpen = false;
    commentTarget = null;
    commentDraft = "";
    commentsOpen = false;
    activeCommentId = null;
    editingCommentId = null;
    editingCommentText = "";
  }

  function resetNewNote(): void {
    if (saveTimer) clearTimeout(saveTimer);
    selectedId = null;
    savedVersion = null;
    title = "";
    body = "";
    tags = [];
    tagDraft = "";
    comments = [];
    resetCommentUi();
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
    comments = [...(note.comments ?? [])];
    resetCommentUi();
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
    const submitted = { title, body, tags: [...tags], comments: comments.map((comment) => ({ ...comment })) };
    saveState = "saving";
    message = "Saving";
    try {
      const result = selectedId
        ? await invoke("write", {
            target: selectedId,
            body: submitted.body,
            title: submitted.title,
            tags: submitted.tags,
            comments: submitted.comments,
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

  function updateSelection(): void {
    const element = bodyInput;
    if (!element) return;
    const from = element.selectionStart ?? 0;
    const to = element.selectionEnd ?? 0;
    selection = from < to ? { from, to, text: body.slice(from, to) } : null;
  }

  function contextAround(from: number, to: number): { before: string; after: string } {
    return {
      before: body.slice(Math.max(0, from - 180), from),
      after: body.slice(to, Math.min(body.length, to + 180)),
    };
  }

  function selectionPreview(text: string): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
  }

  function commentId(): string {
    // A sandboxed (opaque-origin) frame may lack crypto.randomUUID.
    return typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `comment-${crypto.randomUUID()}`
      : `comment-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
  }

  async function openCommentComposer(): Promise<void> {
    if (!selection) return;
    commentTarget = selection;
    commentDraft = "";
    commentComposerOpen = true;
    await tick();
    commentComposerInput?.focus();
  }

  function closeCommentComposer(): void {
    commentComposerOpen = false;
    commentTarget = null;
    commentDraft = "";
  }

  function addComment(): void {
    const text = commentDraft.trim();
    if (!commentTarget || text === "") return;
    const context = contextAround(commentTarget.from, commentTarget.to);
    comments = [...comments, {
      comment_id: commentId(),
      text,
      selected_text: commentTarget.text,
      selection_start: commentTarget.from,
      selection_end: commentTarget.to,
      context_before: context.before,
      context_after: context.after,
      created_at: new Date().toISOString(),
    }];
    closeCommentComposer();
    commentsOpen = true;
    edit();
  }

  function removeComment(id: string): void {
    if (editingCommentId === id) {
      editingCommentId = null;
      editingCommentText = "";
    }
    if (activeCommentId === id) activeCommentId = null;
    comments = comments.filter((comment) => comment.comment_id !== id);
    edit();
  }

  function startEditComment(comment: NoteComment): void {
    editingCommentId = comment.comment_id;
    editingCommentText = comment.text;
  }

  function cancelEditComment(): void {
    editingCommentId = null;
    editingCommentText = "";
  }

  function saveEditComment(): void {
    const text = editingCommentText.trim();
    if (editingCommentId === null || text === "") return;
    const editedId = editingCommentId;
    comments = comments.map((comment) => (comment.comment_id === editedId ? { ...comment, text } : comment));
    cancelEditComment();
    edit();
  }

  /** Select the commented passage in the note body and scroll near it. */
  function revealComment(comment: NoteComment): void {
    const range = locateNoteComment(body, comment);
    const element = bodyInput;
    if (!range || !element) return;
    activeCommentId = comment.comment_id;
    element.focus();
    element.setSelectionRange(range.from, range.to);
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 24;
    const linesAbove = body.slice(0, range.from).split("\n").length - 1;
    element.scrollTop = Math.max(0, linesAbove * lineHeight - element.clientHeight / 3);
    updateSelection();
  }

  /** Open a comment's card in the comments section and scroll it into view. */
  async function openComment(id: string): Promise<void> {
    if (!comments.some((comment) => comment.comment_id === id)) return;
    commentsOpen = true;
    activeCommentId = id;
    await tick();
    document.getElementById(`note-comment-${id}`)?.scrollIntoView({ block: "nearest" });
  }

  /** A click (collapsed caret) inside a marked range opens that comment. */
  function bodyClick(): void {
    const element = bodyInput;
    if (!element) return;
    const caret = element.selectionStart ?? 0;
    if (caret !== (element.selectionEnd ?? 0)) return;
    for (const comment of comments) {
      const range = locateNoteComment(body, comment);
      if (range && caret >= range.from && caret <= range.to) {
        void openComment(comment.comment_id);
        return;
      }
    }
  }

  /** Keep the highlight backdrop aligned with the textarea's scroll position. */
  function syncBackdrop(): void {
    const element = bodyInput;
    const backdrop = bodyBackdrop;
    if (!element || !backdrop) return;
    backdrop.scrollTop = element.scrollTop;
    backdrop.scrollLeft = element.scrollLeft;
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
      {#if allTags.length > 0}
        <div class="tag-filter" role="group" aria-label="Filter notes by tag">
          {#each allTags as tag (tag)}
            <button
              type="button"
              class="filter-chip"
              class:active={activeTagFilter.includes(tag)}
              aria-pressed={activeTagFilter.includes(tag)}
              onclick={() => toggleTagFilter(tag)}
            >{tag}</button>
          {/each}
          {#if activeTagFilter.length > 0}
            <button type="button" class="filter-clear" onclick={() => (tagFilter = [])}>Clear</button>
          {/if}
        </div>
      {/if}
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

    <!-- One slim utility row: save status on the left, commenting on the
         right. Keeps the editor as tall as possible without hiding state. -->
    <div class="utility" class:failed={saveState === "failed"}>
      <span class="status-message" role="status" aria-live="polite">{message}</span>
      {#if saveState === "failed"}<button type="button" onclick={() => void save()}>Retry</button>{/if}
      {#if externalConflict || selected?.externally_modified}
        <button type="button" onclick={() => void loadExternalVersion()}>Load file, discard draft</button>
        <button type="button" onclick={() => void save(true)}>Overwrite with draft</button>
      {/if}
      <span class="selection-summary" class:hint={!selection}>
        {selection ? `“${selectionPreview(selection.text)}”` : "Select text to comment."}
      </span>
      <button type="button" disabled={!selection} aria-expanded={commentComposerOpen} onclick={() => void openCommentComposer()}>
        Add comment
      </button>
    </div>

    {#if commentComposerOpen && commentTarget}
      <section class="comment-composer" aria-label="Add comment to selection">
        <label for="selection-comment">Comment on “{selectionPreview(commentTarget.text)}”</label>
        <textarea
          id="selection-comment"
          bind:this={commentComposerInput}
          bind:value={commentDraft}
          rows="3"
          placeholder="Write your comment"
        ></textarea>
        <div class="comment-actions">
          <button type="button" class="primary" disabled={commentDraft.trim() === ""} onclick={addComment}>Add comment</button>
          <button type="button" onclick={closeCommentComposer}>Cancel</button>
        </div>
      </section>
    {/if}

    <div class="body-wrap">
      <!-- Transparent-text mirror of the body; only the comment marks show.
           Sits behind the textarea so commented passages highlight in place. -->
      <div class="body-backdrop body-text" bind:this={bodyBackdrop} aria-hidden="true">{#each bodySegments as segment, index (index)}{#if segment.commentId}<mark class:active={segment.commentId === activeCommentId}>{segment.text}</mark>{:else}{segment.text}{/if}{/each}{"\n"}</div>
      <textarea
        class="body body-text"
        bind:this={bodyInput}
        bind:value={body}
        oninput={() => { edit(); updateSelection(); syncBackdrop(); }}
        onselect={updateSelection}
        onmouseup={updateSelection}
        onkeyup={updateSelection}
        onclick={bodyClick}
        onscroll={syncBackdrop}
        aria-label="Note body"
        placeholder="Write in Markdown…"
        spellcheck="true"
      ></textarea>
    </div>

    {#if comments.length > 0}
      <section class="comments" aria-label="Note comments">
        <button type="button" class="comments-toggle" aria-expanded={commentsOpen} onclick={() => (commentsOpen = !commentsOpen)}>
          <svg class="chevron" class:open={commentsOpen} viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <strong>{comments.length === 1 ? "1 comment" : `${comments.length} comments`}</strong>
          <span class="comments-hint">Marked text in the note is commented — click it to open the comment.</span>
        </button>
        {#if commentsOpen}
          <div class="comment-list">
            {#each comments as comment (comment.comment_id)}
              {@const anchored = locateNoteComment(body, comment) !== null}
              <article class="comment-card" class:active={activeCommentId === comment.comment_id} id={`note-comment-${comment.comment_id}`}>
                <button
                  class="comment-quote"
                  type="button"
                  disabled={!anchored}
                  title={anchored ? "Show in note" : "The commented text has changed"}
                  onclick={() => revealComment(comment)}
                >
                  <q>{selectionPreview(comment.selected_text)}</q>
                </button>
                {#if !anchored}<p class="comment-unanchored">The commented text has changed; showing the original quote.</p>{/if}
                {#if editingCommentId === comment.comment_id}
                  <textarea
                    class="comment-edit"
                    bind:value={editingCommentText}
                    rows="2"
                    aria-label={`Edit comment on ${selectionPreview(comment.selected_text)}`}
                  ></textarea>
                  <div class="comment-actions">
                    <button type="button" class="primary" disabled={editingCommentText.trim() === ""} onclick={saveEditComment}>Save comment</button>
                    <button type="button" onclick={cancelEditComment}>Cancel</button>
                  </div>
                {:else}
                  <p class="comment-text">{comment.text}</p>
                  <div class="comment-actions">
                    <button type="button" aria-label={`Edit comment on ${selectionPreview(comment.selected_text)}`} onclick={() => startEditComment(comment)}>Edit</button>
                    <button type="button" class="danger" aria-label={`Remove comment on ${selectionPreview(comment.selected_text)}`} onclick={() => removeComment(comment.comment_id)}>Remove</button>
                  </div>
                {/if}
              </article>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
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
  /* The host renders this surface full-height (fill mode); own the whole
     frame and let the note list, body, and comments scroll internally. */
  main { height: 100vh; height: 100dvh; min-height: min(76dvh, 54rem); display: grid; grid-template-columns: minmax(13rem, 18rem) minmax(0, 1fr); background: #fffdf8; }
  aside { min-width: 0; border-right: 1px solid #d8cfc0; background: #eee7da; display: flex; flex-direction: column; }
  .list-tools { display: grid; gap: 0.55rem; padding: 0.8rem; }
  .new { background: #623b25; color: #fffaf2; border-color: #623b25; font-weight: 700; }
  .list-tools input { width: 100%; min-width: 0; border: 1px solid #c8bdad; border-radius: 0.55rem; background: #fffdf8; padding: 0.5rem 0.65rem; }
  .tag-filter { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem; }
  .filter-chip, .filter-clear { min-height: 1.7rem; padding: 0.1rem 0.6rem; border-radius: 999px; font-size: 0.78rem; }
  .filter-chip.active { background: #623b25; border-color: #623b25; color: #fffaf2; }
  .filter-clear { border-color: transparent; background: transparent; color: #706558; text-decoration: underline; }
  .list-toggle { display: none; }
  .note-list { min-height: 0; overflow-y: auto; display: grid; align-content: start; gap: 0.2rem; padding: 0 0.45rem 0.7rem; }
  .note-list > button { min-width: 0; display: grid; gap: 0.1rem; text-align: left; border-color: transparent; background: transparent; padding: 0.65rem; }
  .note-list > button.active { background: #fffdf8; border-color: #c8bdad; }
  .note-list strong, .note-list small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note-list small { color: #706558; }
  .note-list p { padding: 0 0.5rem; color: #706558; }
  /* Flex column: the comment composer and comments panel come and go. */
  .editor { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  header { min-width: 0; flex-shrink: 0; display: flex; align-items: center; gap: 0.7rem; padding: 0.7rem 1rem; border-bottom: 1px solid #e4ddd2; }
  .title { min-width: 0; flex: 1; border: none; background: transparent; color: inherit; font: 700 clamp(1.05rem, 0.98rem + 0.35vw, 1.3rem)/1.3 ui-serif, Georgia, serif; padding: 0.35rem; }
  .actions, .dialog-actions { display: flex; flex-wrap: wrap; gap: 0.45rem; }
  .danger { color: #8a2525; border-color: #d9a4a0; background: #fff2f0; }
  .tags { min-width: 0; flex-shrink: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 0.35rem; padding: 0.5rem 1rem; border-bottom: 1px solid #e4ddd2; background: #faf6ee; }
  .tag-label { color: #706558; font-size: 0.8rem; font-weight: 700; }
  .tag { display: inline-flex; align-items: center; gap: 0.2rem; border-radius: 999px; background: #ead8c6; padding: 0.15rem 0.25rem 0.15rem 0.55rem; font-size: 0.8rem; }
  .tag button { min-width: 1.5rem; min-height: 1.5rem; border: none; border-radius: 50%; background: transparent; padding: 0; }
  .tags input { min-width: 6rem; flex: 1; border: none; background: transparent; padding: 0.35rem; }
  .add-tag { min-height: 1.8rem; padding-block: 0.2rem; }
  .utility { min-width: 0; flex-shrink: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; padding: 0.3rem 1rem; min-height: 2.5rem; color: #706558; font-size: 0.82rem; border-bottom: 1px solid #e4ddd2; background: #faf6ee; }
  .status-message { min-width: 0; flex: 1 1 10rem; overflow-wrap: anywhere; }
  .utility.failed { color: #8a2525; background: #fff2f0; }
  .utility button { min-height: 1.8rem; padding-block: 0.2rem; }
  /* The backdrop and the textarea share one grid cell, identical typography
     and padding, so the backdrop's comment marks sit exactly under the
     textarea's (visible) text. */
  .body-wrap { flex: 1; min-width: 0; min-height: 12rem; display: grid; background: #fffdf8; }
  .body-wrap > * { grid-area: 1 / 1; }
  .body-text { padding: clamp(1rem, 0.7rem + 1.2vw, 2rem); font: 1rem/1.65 ui-monospace, "Cascadia Code", monospace; }
  .body-backdrop { overflow: hidden; white-space: pre-wrap; word-wrap: break-word; color: transparent; user-select: none; pointer-events: none; }
  .body-backdrop mark { color: transparent; background: #f2e3c0; border-bottom: 2px solid #b3854f; border-radius: 2px; padding: 0; }
  .body-backdrop mark.active { background: #ead0a0; border-bottom-color: #9d5d2e; }
  .body { width: 100%; min-width: 0; min-height: 0; resize: none; overflow: auto; border: none; background: transparent; color: inherit; }
  .selection-summary { min-width: 0; flex: 0 1 auto; max-width: min(50%, 22rem); margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hint { color: #706558; }
  .comment-composer { flex-shrink: 0; display: grid; gap: 0.45rem; padding: 0.6rem 1rem; border-bottom: 1px solid #e4ddd2; background: #faf6ee; }
  .comment-composer label { font-size: 0.82rem; font-weight: 700; color: #706558; overflow-wrap: anywhere; }
  .comment-composer textarea, .comment-edit { width: 100%; min-width: 0; resize: vertical; border: 1px solid #c8bdad; border-radius: 0.55rem; background: #fffdf8; color: inherit; padding: 0.5rem 0.65rem; }
  .comment-actions { display: flex; flex-wrap: wrap; gap: 0.45rem; }
  .primary { background: #623b25; color: #fffaf2; border-color: #623b25; font-weight: 700; }
  .comments { flex-shrink: 0; display: grid; border-top: 1px solid #e4ddd2; background: #faf6ee; }
  .comments-toggle { min-width: 0; display: flex; align-items: center; gap: 0.5rem; border: none; border-radius: 0; background: transparent; padding: 0.55rem 1rem; text-align: left; }
  .comments-hint { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #706558; font-size: 0.78rem; }
  .chevron { flex-shrink: 0; transition: transform 120ms ease; }
  .chevron.open { transform: rotate(90deg); }
  .comment-list { max-height: 14rem; overflow-y: auto; display: grid; gap: 0.5rem; padding: 0 1rem 0.7rem; }
  .comment-card { display: grid; gap: 0.35rem; border: 1px solid #e4ddd2; border-radius: 0.55rem; background: #fffdf8; padding: 0.55rem 0.7rem; }
  .comment-card.active { border-color: #b3854f; background: #fdf6e9; }
  .comment-quote { min-height: auto; width: fit-content; max-width: 100%; text-align: left; border: none; background: transparent; padding: 0; color: #9d5d2e; overflow-wrap: anywhere; }
  .comment-quote q { text-decoration: underline; text-underline-offset: 0.18em; }
  .comment-quote:disabled { color: #706558; }
  .comment-quote:disabled q { text-decoration: none; }
  .comment-text { margin: 0; overflow-wrap: anywhere; }
  .comment-unanchored { margin: 0; font-size: 0.78rem; color: #706558; }
  .backdrop { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; padding: 1rem; background: #27231dcc; }
  .dialog { width: min(100%, 28rem); border-radius: 0.85rem; background: #fffdf8; padding: 1.2rem; box-shadow: 0 1rem 3rem #27231d55; }
  .dialog h2 { margin: 0; font: 700 1.2rem/1.3 ui-serif, Georgia, serif; }
  .dialog p { margin: 0.6rem 0 1rem; }
  .dialog-actions { justify-content: flex-end; }
  :global(html[data-theme="dark"]) :global(body),
  :global(html[data-theme="dark"]) main,
  :global(html[data-theme="dark"]) .body-wrap,
  :global(html[data-theme="dark"]) .dialog { background: #211e19; color: #eee7da; }
  :global(html[data-theme="dark"]) aside { background: #181611; border-color: #4b443a; }
  :global(html[data-theme="dark"]) button,
  :global(html[data-theme="dark"]) .list-tools input { background: #2a261f; border-color: #5c5347; color: inherit; }
  :global(html[data-theme="dark"]) .new,
  :global(html[data-theme="dark"]) .primary { background: #b36f3d; border-color: #b36f3d; color: #17130f; }
  :global(html[data-theme="dark"]) .note-list > button.active,
  :global(html[data-theme="dark"]) .tags { background: #2a261f; border-color: #5c5347; }
  :global(html[data-theme="dark"]) header,
  :global(html[data-theme="dark"]) .tags { border-color: #4b443a; }
  :global(html[data-theme="dark"]) .utility,
  :global(html[data-theme="dark"]) .comment-composer,
  :global(html[data-theme="dark"]) .comments { background: #2a261f; border-color: #4b443a; }
  :global(html[data-theme="dark"]) .comment-composer textarea,
  :global(html[data-theme="dark"]) .comment-edit { background: #211e19; color: #eee7da; border-color: #5c5347; }
  :global(html[data-theme="dark"]) .body { background: transparent; color: #eee7da; }
  :global(html[data-theme="dark"]) .body-backdrop mark { background: #513824; border-bottom-color: #b36f3d; }
  :global(html[data-theme="dark"]) .body-backdrop mark.active { background: #6b4526; border-bottom-color: #e0a370; }
  :global(html[data-theme="dark"]) .comments-toggle { background: transparent; border: none; }
  :global(html[data-theme="dark"]) .comments-hint { color: #a89d8d; }
  :global(html[data-theme="dark"]) .comment-card.active { border-color: #b36f3d; background: #2a2018; }
  :global(html[data-theme="dark"]) .filter-chip.active { background: #b36f3d; border-color: #b36f3d; color: #17130f; }
  :global(html[data-theme="dark"]) .filter-clear { background: transparent; border-color: transparent; color: #a89d8d; }
  :global(html[data-theme="dark"]) .comment-card { background: #211e19; border-color: #4b443a; }
  :global(html[data-theme="dark"]) .comment-quote { background: transparent; border: none; color: #e0a370; }
  :global(html[data-theme="dark"]) .comment-quote:disabled,
  :global(html[data-theme="dark"]) .hint,
  :global(html[data-theme="dark"]) .comment-unanchored,
  :global(html[data-theme="dark"]) .comment-composer label { color: #a89d8d; }
  :global(html[data-theme="dark"]) .tag { background: #513824; }
  :global(html[data-theme="dark"]) .utility.failed,
  :global(html[data-theme="dark"]) .danger { color: #ffc2ba; background: #462522; border-color: #81504a; }
  :global(html[data-theme="dark"]) .backdrop { background: #000b; }
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
