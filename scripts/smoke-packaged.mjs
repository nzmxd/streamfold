#!/usr/bin/env node
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const searchArgument = process.argv.slice(2).find((value) => value !== '--')
const searchRoot = resolve(searchArgument ?? 'release')
const archives = await findFiles(searchRoot, 'app.asar', 7)
if (archives.length === 0) throw new Error(`未在 ${searchRoot} 中找到已打包的 app.asar`)

for (const archivePath of archives) {
  const executable = await packagedExecutable(archivePath)
  const temporary = await mkdtemp(join(tmpdir(), 'streamfold-package-smoke-'))
  const resultPath = join(temporary, 'result.json')
  try {
    const { command, args } = launchCommand(executable)
    const output = await run(command, args, {
      ...process.env,
      SOCIAL_VAULT_SMOKE: '1',
      SOCIAL_VAULT_SMOKE_RESULT: resultPath
    })
    let result
    try {
      result = JSON.parse(await readFile(resultPath, 'utf8'))
    } catch {
      throw new Error(`安装目录启动 Smoke 未生成结果：${output.slice(-2_000)}`)
    }
    if (result?.sandbox?.quickjs !== true || result?.shell?.pluginCount < 3 || result?.shell?.catalogReady !== true) {
      throw new Error(`安装目录插件运行 Smoke 结果无效：${JSON.stringify(result)}`)
    }
    process.stdout.write(`安装目录插件运行 Smoke 通过：${executable}\n`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function packagedExecutable(archivePath) {
  const resources = dirname(archivePath)
  if (process.platform === 'darwin') {
    return chooseExecutable(join(dirname(resources), 'MacOS'))
  }
  return chooseExecutable(dirname(resources))
}

async function chooseExecutable(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(directory, entry.name))
  const preferred = process.platform === 'win32'
    ? files.filter((path) => /(?:归页|streamfold).*\.exe$/i.test(basename(path)))
    : files.filter((path) => /^(?:归页|streamfold)$/i.test(basename(path)))
  for (const path of [...preferred, ...files]) {
    if (process.platform === 'win32' && !path.toLowerCase().endsWith('.exe')) continue
    if (process.platform !== 'win32' && !await isExecutable(path)) continue
    if (/^(?:chrome-sandbox|chrome_crashpad_handler)$/i.test(basename(path))) continue
    return path
  }
  throw new Error(`未在 ${directory} 中找到应用可执行文件`)
}

function launchCommand(executable) {
  if (process.platform === 'linux') {
    // GitHub-hosted runners cannot give the unpacked chrome-sandbox helper the
    // root ownership and setuid mode Chromium requires. Disable Chromium's
    // sandbox only for this isolated package smoke process; the packaged
    // application and its normal launch arguments remain unchanged.
    return { command: 'xvfb-run', args: ['-a', executable, '--no-sandbox'] }
  }
  return { command: executable, args: [] }
}

async function run(command, args, env) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const append = (chunk) => { output = `${output}${chunk}`.slice(-20_000) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timeout = setTimeout(() => {
      child.kill()
      rejectPromise(new Error(`安装目录启动 Smoke 超时：${output.slice(-2_000)}`))
    }, 60_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectPromise(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolvePromise(output)
      else rejectPromise(new Error(`安装目录启动 Smoke 退出码 ${code ?? 'unknown'}：${output.slice(-2_000)}`))
    })
  })
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function findFiles(root, name, depth) {
  if (depth < 0) return []
  let children
  try {
    children = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const child of children) {
    const path = join(root, child.name)
    if (child.isFile() && child.name === name) found.push(path)
    else if (child.isDirectory()) found.push(...await findFiles(path, name, depth - 1))
  }
  return found
}
