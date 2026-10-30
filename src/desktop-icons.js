import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./desktop-icons.ps1', import.meta.url))

/** Only the desktop Host may resolve its direct Electron parent. Headless hosts stay dormant. */
export function desktopIconCommand(runtime = process) {
  if (runtime.platform !== 'win32' ||
      win32.basename(runtime.execPath).toLowerCase() !== 'deepseek harness.exe' ||
      !runtime.argv.some(value => /[/\\]@deepseek-ai[/\\]dsh-desktop-host[/\\]lib[/\\]index[.]js$/i.test(value))) return undefined
  if (!Number.isSafeInteger(runtime.pid) || runtime.pid <= 0 || !runtime.env.SystemRoot) return undefined
  return {
    command: win32.join(runtime.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-HostProcessId', String(runtime.pid)],
  }
}

/** Register once inside the plugin's existing enabled lifecycle. No Host IPC or new dependency. */
export function installDesktopIcons(ctx) {
  const invocation = desktopIconCommand()
  if (!invocation) return
  return ctx.effect(() => {
    const child = spawn(invocation.command, invocation.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stopping = false
    let errors = ''
    child.unref()
    child.stdout.resume()
    for (const stream of child.stdio) stream?.unref?.()
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4096) })
    child.stdin.on('error', () => {}) // The child may reject an unsupported desktop before disposal.
    child.on('error', error => { console.warn('[dsh-session-top] desktop icons:', error.message) })
    child.on('exit', code => {
      if (code !== 0) console.warn('[dsh-session-top] desktop icons:', errors.trim() || `helper exited ${code}`)
    })
    // EOF also reaches the native finally block if this Host exits without Cordis disposal.
    return () => {
      if (stopping) return
      stopping = true
      child.stdin.end('stop\n')
    }
  }, 'dsh-session-top: desktop icons')
}
