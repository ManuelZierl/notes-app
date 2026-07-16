export interface NoteComment {
  comment_id: string;
  text: string;
  selected_text: string;
  selection_start: number;
  selection_end: number;
  context_before: string;
  context_after: string;
  created_at: string;
}

/**
 * Re-anchor a comment to the current note body. The stored offsets win when
 * they still quote the commented text; otherwise the quote is searched with
 * its surrounding context, then bare. An anchor is only trusted when it is
 * unambiguous — a repeated quote with stale context yields null rather than
 * a guess.
 */
export function locateNoteComment(body: string, comment: NoteComment): { from: number; to: number } | null {
  let from = comment.selection_start;
  let to = comment.selection_end;
  if (body.slice(from, to) !== comment.selected_text) {
    const contextualMatch = `${comment.context_before}${comment.selected_text}${comment.context_after}`;
    const contextStart = body.indexOf(contextualMatch);
    const contextIsUnique = contextStart >= 0 && body.indexOf(contextualMatch, contextStart + 1) < 0;
    const quoteStart = body.indexOf(comment.selected_text);
    const quoteIsUnique = quoteStart >= 0 && body.indexOf(comment.selected_text, quoteStart + 1) < 0;
    from = contextIsUnique
      ? contextStart + comment.context_before.length
      : quoteIsUnique ? quoteStart : -1;
    to = from + comment.selected_text.length;
  }
  return from >= 0 && to <= body.length && from < to ? { from, to } : null;
}
