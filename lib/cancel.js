// lib/cancel.js — track cancellable tasks and notify the extension.

const cancelled = new Set();
const listeners = new Set();

function onCancel(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function cancel(taskId) {
  cancelled.add(String(taskId));
  for (const fn of listeners) { try { fn(taskId); } catch (_) {} }
  return true;
}
function isCancelled(taskId) { return cancelled.has(String(taskId)); }
function clear(taskId) { cancelled.delete(String(taskId)); }

module.exports = { onCancel, cancel, isCancelled, clear };
