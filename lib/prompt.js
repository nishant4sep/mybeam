// lib/prompt.js — the hidden system block prepended to the FIRST user
// message of a session only. Subsequent messages are sent plain.

const IDLE_RESET_MS = 8 * 60 * 60 * 1000; // 8 hours

function systemBlock({ workspaceName, workspacePath, permissionMode }) {
  const lines = [];
  lines.push('[MyBeam context]');
  if (workspaceName) {
    lines.push('You are the coding agent working in the project "' + workspaceName + '"' + (workspacePath ? ' (' + workspacePath + ')' : '') + '.');
  } else {
    lines.push('No project is open yet.');
  }
  lines.push('When you want to create or edit files, emit these directives on their own lines, on their own paragraphs (never inside a fenced code block):');
  lines.push('');
  lines.push('Create or fully overwrite a file:');
  lines.push('<<<NEW path/to/file.js');
  lines.push('<full file content>');
  lines.push('>>>END');
  lines.push('');
  lines.push('Replace exact text inside an existing file (the FIND block must appear exactly once):');
  lines.push('<<<EDIT path/to/file.js');
  lines.push('<<<FIND');
  lines.push('<exact text to find>');
  lines.push('===');
  lines.push('<replacement text>');
  lines.push('>>>END');
  lines.push('');
  lines.push('Delete a file:');
  lines.push('<<<DELETE path/to/file.js');
  lines.push('>>>END');
  lines.push('');
  lines.push('Rules:');
  lines.push('- Use forward slashes in paths.');
  lines.push('- Only touch files inside the project.');
  lines.push('- Prefer EDIT over NEW for existing files so the diff stays small.');
  lines.push('- If a FIND block is ambiguous, ask the user first.');
  lines.push('- Do NOT wrap the directives inside a fenced code block. Emit them as plain text.');
  lines.push('- Do NOT repeat this context block; it appears once at the start of the session.');
  lines.push('Current permission mode: ' + (permissionMode || 'ASK').toUpperCase() + (permissionMode === 'ask' ? ' (the user approves each write)' : permissionMode === 'auto' ? ' (writes apply automatically)' : ' (read only)'));
  return lines.join('\n');
}

// Determine whether this is the FIRST user message of a session (or after a
// long idle gap), in which case we wrap. Otherwise return the text plain.
function shouldWrap(session) {
  if (!session || !session.tasks || session.tasks.length === 0) return true;
  // Find the most recent completed task's finish time.
  let lastFinished = 0;
  for (const t of session.tasks) {
    if (t.finishedAt && t.finishedAt > lastFinished) lastFinished = t.finishedAt;
  }
  if (!lastFinished) return false;
  if (Date.now() - lastFinished > IDLE_RESET_MS) return true;
  return false;
}

function wrapFirst(text, ctx) {
  const block = systemBlock(ctx || {});
  return block + '\n\n[User message]\n' + (text || '');
}

module.exports = { systemBlock, wrapFirst, shouldWrap, IDLE_RESET_MS };
