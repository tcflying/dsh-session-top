import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { desktopIconCommand } from '../src/desktop-icons.js'

test('desktop icons accept only the Windows Electron desktop Host', () => {
  const runtime = {
    platform: 'win32', execPath: 'G:/DeepSeek Harness/DeepSeek Harness.exe', pid: 72336,
    argv: ['G:/DeepSeek Harness/DeepSeek Harness.exe', 'G:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'],
    env: { SystemRoot: 'C:/Windows' },
  }
  const result = desktopIconCommand(runtime)
  assert.equal(result.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.deepEqual(result.args.slice(-2), ['-HostProcessId', '72336'])
  assert.equal(result.args.includes('-File'), true)
  for (const change of [
    { platform: 'linux' }, { execPath: 'G:/Other/App.exe' }, { argv: ['node', 'server.js'] },
    { pid: 0 }, { pid: '72336' }, { env: {} },
  ]) assert.equal(desktopIconCommand({ ...runtime, ...change }), undefined)
})

test('native icons cover every pixel with opaque white at small and large DPI sizes', { skip: process.platform !== 'win32' }, () => {
  const source = readFileSync(new URL('../src/desktop-icons.ps1', import.meta.url), 'utf8')
    .match(/Add-Type @'([\s\S]*?)'@ -ReferencedAssemblies System.Drawing/)[1]
  // Compile only the native class; do not run the helper or mutate desktop icons.
  const command = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
${source}
'@ -ReferencedAssemblies System.Drawing
foreach ($size in 16,20,24,32,48,64) {
  $handle = [DshDesktopIcons]::WhiteSquare($size)
  $icon = $null; $bitmap = $null
  try {
    $icon = [Drawing.Icon]::FromHandle($handle)
    $bitmap = $icon.ToBitmap()
    if ($bitmap.Width -ne $size -or $bitmap.Height -ne $size) { throw "Wrong icon dimensions: $size" }
    for ($y=0; $y -lt $size; $y++) {
      for ($x=0; $x -lt $size; $x++) {
        if ($bitmap.GetPixel($x,$y).ToArgb() -ne -1) { throw "Icon pixel must be opaque white: size=$size x=$x y=$y" }
      }
    }
  } finally {
    if ($bitmap) { $bitmap.Dispose() }
    if ($icon) { $icon.Dispose() }
    [DshDesktopIcons]::DestroyIcon($handle) | Out-Null
  }
}`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
})

test('native helper rejects an ordinary process before any icon mutation', { skip: process.platform !== 'win32' }, () => {
  const script = fileURLToPath(new URL('../src/desktop-icons.ps1', import.meta.url))
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-HostProcessId', String(process.pid)], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  assert.equal(result.status, 1, result.error?.message)
  assert.match(result.stderr, /Desktop icons require the DSH desktop Host process/)
  assert.equal(result.stdout.includes('"status":"applied"'), false)
})

// Explicit opt-in mutates only the validated Host's parent icons, then restores them.
test('live native readback and reversible screenshots', {
  skip: process.platform !== 'win32' || !process.env.DSH_DESKTOP_ICON_HOST_PID,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-icons-'))
  try {
    const script = fileURLToPath(new URL('../src/desktop-icons.ps1', import.meta.url))
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-HostProcessId', process.env.DSH_DESKTOP_ICON_HOST_PID, '-Probe', '-EvidenceDirectory', directory],
      { encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    const [applied, restored] = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
    assert.equal(applied.readSmall, applied.smallIcon)
    assert.equal(applied.readLarge, applied.largeIcon)
    assert.equal(applied.notifyIcon, true)
    assert.equal(restored.smallRestored, true)
    assert.equal(restored.largeRestored, true)
    assert.notDeepEqual(readFileSync(join(directory, 'before-tray.png')), readFileSync(join(directory, 'after-tray.png')))
    assert.deepEqual(readFileSync(join(directory, 'before-tray.png')), readFileSync(join(directory, 'restored-tray.png')))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
