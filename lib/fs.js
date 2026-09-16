// lib/fs.js — deterministic folder picker for workspace.
// Kept separate so we can swap it out cleanly later.
// Re-exports lib/dialog's pickFolder.

const dialog = require('./dialog');
module.exports = { pickFolder: dialog.pickFolder };
