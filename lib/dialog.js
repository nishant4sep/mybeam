// lib/dialog.js — native folder picker via PowerShell on Windows.
//
// OpenFileDialog in folder-picking mode returns `<folder>\<filename>`.
// We always take the parent directory, ignoring whatever the filename field says.
// The `[Select this folder]` string the user sees is just the dialog's default
// FileName value; it never gets used as a path.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PS_SCRIPT_LINES = [
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  'Add-Type -AssemblyName System.Drawing | Out-Null',
  '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
  "$dlg.Title = 'Select your project folder for MyBeam'",
  "$dlg.Filter = 'Folders|*.'",
  '$dlg.CheckFileExists = $false',
  '$dlg.CheckPathExists = $true',
  '$dlg.ValidateNames = $false',
  '$dlg.FileName = "[Select this folder]"',
  '$dlg.RestoreDirectory = $true',
  '$dlg.InitialDirectory = [Environment]::GetFolderPath("UserProfile")',
  '$dlg.ShowHelp = $false',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$owner.ShowInTaskbar = $false',
  '$owner.WindowState = "Minimized"',
  '$owner.Opacity = 0',
  '$res = $dlg.ShowDialog($owner)',
  'if ($res -eq [System.Windows.Forms.DialogResult]::OK) {',
  '  $chosen = $dlg.FileName',
  '  # Always take the parent directory — OpenFileDialog returns folder+filename.',
  '  $folder = Split-Path $chosen -Parent',
  '  # Fallback: if Split-Path failed (drive root case), use the chosen path itself.',
  '  if (-not $folder) { $folder = $chosen }',
  '  [Console]::Out.Write($folder)',
  '}',
  '$owner.Dispose()'
];

function writeTempScript() {
  const dir = os.tmpdir();
  const name = 'mybeam-pick-' + process.pid + '-' + Date.now() + '.ps1';
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, PS_SCRIPT_LINES.join('\r\n'), 'utf8');
  return abs;
}

function pickFolderWindows(timeoutMs = 300000) {
  return new Promise((resolve) => {
    let scriptPath = null;
    try { scriptPath = writeTempScript(); }
    catch (e) { return resolve({ ok: false, reason: 'temp-write-failed: ' + e.message }); }

    const args = [
      '-NoProfile',
      '-STA',
      '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath
    ];

    let child;
    try { child = spawn('powershell.exe', args, { windowsHide: true }); }
    catch (e) {
      try { fs.unlinkSync(scriptPath); } catch (_) {}
      return resolve({ ok: false, reason: 'spawn-failed: ' + e.message });
    }

    let stdout = ''; let stderr = '';
    let done = false;
    const cleanup = () => { try { fs.unlinkSync(scriptPath); } catch (_) {} };

    const timer = setTimeout(() => {
      if (done) return; done = true;
      try { child.kill(); } catch (_) {}
      cleanup();
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timer);
      cleanup();
      resolve({ ok: false, reason: 'spawn-error: ' + e.message });
    });

    child.on('close', () => {
      if (done) return; done = true; clearTimeout(timer);
      cleanup();
      const p = stdout.trim();
      if (!p) return resolve({ ok: false, reason: 'cancelled', stderr: stderr.trim() });
      const clean = p.replace(/^\uFEFF/, '').trim();
      resolve({ ok: true, path: clean });
    });
  });
}

async function pickFolder() {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported-platform' };
  return pickFolderWindows();
}

module.exports = { pickFolder };
