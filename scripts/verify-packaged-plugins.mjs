#!/usr/bin/env node
import { listPackage } from '@electron/asar'
import { createPublicKey } from 'node:crypto'
import { access, readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPluginArchive } from '../packages/plugin-sdk/dist/package-format.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const searchArgument = process.argv.slice(2).find((value) => value !== '--')
const searchRoot = resolve(searchArgument ?? join(repositoryRoot, 'release'))
const trust = JSON.parse(await readFile(
  join(repositoryRoot, 'tooling', 'builtin-plugins', 'streamfold.webhook', 'trust.json'),
  'utf8'
))
const archives = await findFiles(searchRoot, 'app.asar', 7)

if (archives.length === 0) throw new Error(`未在 ${searchRoot} 中找到已打包的 app.asar`)

for (const archivePath of archives) {
  const entries = new Set(listPackage(archivePath).map(normalizeArchivePath))
  for (const required of [
    'out/main/index.js',
    'out/main/plugin-sandbox.js',
    'node_modules/quickjs-emscripten/package.json',
    'node_modules/quickjs-emscripten-core/package.json',
    'node_modules/@jitl/quickjs-wasmfile-release-sync/package.json'
  ]) {
    if (!entries.has(required) && !(await unpackedEntryExists(archivePath, required))) {
      throw new Error(`${basename(dirname(archivePath))} 缺少插件运行资源：${required}`)
    }
  }

  const packagePath = join(dirname(archivePath), 'plugins', trust.packageFile)
  await access(packagePath)
  const verified = await verifyPluginArchive(await readFile(packagePath), {
    publicKey: createPublicKey({
      key: Buffer.from(trust.publisherPublicKey, 'base64'),
      format: 'der',
      type: 'spki'
    }),
    expectedKeyId: trust.publisherKeyId,
    requireSignature: true
  })
  if (
    verified.manifest.id !== trust.pluginId ||
    verified.manifest.version !== trust.version ||
    verified.archiveHash !== trust.packageHash ||
    verified.contentHash !== trust.contentHash
  ) throw new Error('安装目录中的官方 Webhook 插件与固定信任信息不一致')

  process.stdout.write(`插件打包 Smoke 通过：${archivePath}\n`)
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

function normalizeArchivePath(value) {
  return value.replace(/\\/g, '/').replace(/^\/+/, '')
}

async function unpackedEntryExists(archivePath, entry) {
  try {
    await access(join(`${archivePath}.unpacked`, ...entry.split('/')))
    return true
  } catch {
    return false
  }
}
