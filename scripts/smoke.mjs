import { spawn } from 'node:child_process'
import electron from 'electron'

const electronArgs = [
  '--disable-gpu',
  '--disable-software-rasterizer',
  'out/main/index.js'
]
const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : electron
const args = process.platform === 'win32'
  ? ['/d', '/c', `pnpm exec electron ${electronArgs.join(' ')}`]
  : electronArgs
const child = spawn(executable, args, {
  cwd: process.cwd(),
  env: { ...process.env, SOCIAL_VAULT_SMOKE: '1' },
  stdio: ['ignore', 'inherit', 'inherit']
})

const timeout = setTimeout(() => {
  child.kill()
  process.stderr.write('Electron smoke test timed out.\n')
  process.exitCode = 1
}, 30_000)

child.on('error', (error) => {
  clearTimeout(timeout)
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})

child.on('exit', (code) => {
  clearTimeout(timeout)
  if (code !== 0) {
    process.stderr.write(`Smoke test failed with exit code ${code ?? 'unknown'}.\n`)
    process.exitCode = 1
  }
})
