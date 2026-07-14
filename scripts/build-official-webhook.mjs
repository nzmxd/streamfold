#!/usr/bin/env node
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync
} from 'node:crypto'
import { lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPluginPackageSignature,
  validatePluginEntries,
  verifyPluginArchive,
  writePluginArchive
} from '../packages/plugin-sdk/dist/package-format.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDirectory = join(repositoryRoot, 'tooling', 'builtin-plugins', 'streamfold.webhook')
const resourceDirectory = join(repositoryRoot, 'resources', 'plugins')
const trustDocumentPath = join(sourceDirectory, 'trust.json')
const trustModulePath = join(repositoryRoot, 'src', 'main', 'plugins', 'official-webhook-trust.generated.ts')
const defaultPrivateKeyPath = join(repositoryRoot, '.local-plugin-signing', 'streamfold-official-private.pem')

const [command = 'verify', ...rawArguments] = process.argv.slice(2)
const argumentsMap = parseArguments(rawArguments)

if (command === 'build') await buildPackage()
else if (command === 'verify') await verifyCommittedPackage()
else throw new Error(`未知命令：${command}`)

async function buildPackage() {
  const privateKeyPath = resolve(
    stringArgument('private-key') ??
    process.env.STREAMFOLD_OFFICIAL_PLUGIN_PRIVATE_KEY_FILE ??
    defaultPrivateKeyPath
  )
  if (booleanArgument('generate-local-key') && !(await pathExists(privateKeyPath))) {
    const { privateKey } = generateKeyPairSync('ed25519')
    await mkdir(dirname(privateKeyPath), { recursive: true })
    await writeFile(privateKeyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      flag: 'wx',
      mode: 0o600
    })
    process.stdout.write(`已生成仅供本机保存的签名私钥：${privateKeyPath}\n`)
  }
  if (!(await pathExists(privateKeyPath))) {
    throw new Error(
      '缺少官方插件签名私钥。请设置 STREAMFOLD_OFFICIAL_PLUGIN_PRIVATE_KEY_FILE，' +
      '或仅在首次本地开发时传入 --generate-local-key。'
    )
  }

  const privateKeyBytes = await readFile(privateKeyPath)
  let privateKey
  try {
    privateKey = createPrivateKey(privateKeyBytes)
  } finally {
    privateKeyBytes.fill(0)
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('官方插件签名私钥必须是 Ed25519')

  const entries = await loadSourceEntries(sourceDirectory)
  const unsigned = validatePluginEntries(entries)
  const signature = createPluginPackageSignature(entries, unsigned.manifest.publisher.keyId, privateKey)
  entries.set('signature.json', Buffer.from(`${JSON.stringify(signature, null, 2)}\n`, 'utf8'))
  const archive = writePluginArchive(entries)
  const publicKey = createPublicKey(privateKey)
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const publisherPublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const verified = await verifyPluginArchive(archive, {
    publicKey: publicKeyPem,
    expectedKeyId: unsigned.manifest.publisher.keyId,
    requireSignature: true
  })
  assertOfficialManifest(verified.manifest)

  const packageFile = `${verified.manifest.id}-${verified.manifest.version}.streamfold-plugin`
  const trust = {
    schemaVersion: 1,
    pluginId: verified.manifest.id,
    version: verified.manifest.version,
    packageFile,
    packageHash: verified.archiveHash,
    contentHash: verified.contentHash,
    publisherKeyId: verified.manifest.publisher.keyId,
    publisherPublicKey
  }
  await mkdir(resourceDirectory, { recursive: true })
  await writeFile(join(resourceDirectory, packageFile), archive)
  await writeFile(trustDocumentPath, `${JSON.stringify(trust, null, 2)}\n`, 'utf8')
  await writeFile(trustModulePath, generatedTrustModule(trust), 'utf8')

  await verifyCommittedPackage()
  process.stdout.write(`官方 Webhook 插件已签名：resources/plugins/${packageFile}\n`)
  process.stdout.write(`包摘要：${verified.archiveHash}\n`)
}

async function verifyCommittedPackage() {
  const trust = parseTrustDocument(JSON.parse(await readFile(trustDocumentPath, 'utf8')))
  const archive = await readFile(join(resourceDirectory, trust.packageFile))
  const verified = await verifyPluginArchive(archive, {
    publicKey: publicKeyPem(trust.publisherPublicKey),
    expectedKeyId: trust.publisherKeyId,
    requireSignature: true
  })
  assertOfficialManifest(verified.manifest)
  if (verified.manifest.id !== trust.pluginId || verified.manifest.version !== trust.version) {
    throw new Error('官方 Webhook 插件身份与固定信任信息不一致')
  }
  if (verified.archiveHash !== trust.packageHash || verified.contentHash !== trust.contentHash) {
    throw new Error('官方 Webhook 插件摘要与固定信任信息不一致')
  }

  const source = validatePluginEntries(await loadSourceEntries(sourceDirectory))
  if (source.contentHash !== verified.contentHash) {
    throw new Error('官方 Webhook 插件资源不是由当前源码生成')
  }
  const generatedModule = await readFile(trustModulePath, 'utf8')
  if (generatedModule !== generatedTrustModule(trust)) {
    throw new Error('主进程中的官方 Webhook 信任锚不是当前资源生成的版本')
  }
  process.stdout.write(`官方 Webhook 插件校验通过：${trust.pluginId}@${trust.version}\n`)
}

async function loadSourceEntries(root) {
  const entries = new Map()
  await collectDirectory(entries, root, root)
  entries.delete('trust.json')
  entries.delete('signature.json')
  return entries
}

async function collectDirectory(entries, root, directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, item.name)
    if (item.isSymbolicLink()) throw new Error(`官方插件源码不允许符号链接：${absolutePath}`)
    if (item.isDirectory()) {
      await collectDirectory(entries, root, absolutePath)
      continue
    }
    if (!item.isFile()) throw new Error(`官方插件源码只允许普通文件：${absolutePath}`)
    const metadata = await lstat(absolutePath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`官方插件源码文件无效：${absolutePath}`)
    const name = relative(root, absolutePath).split(sep).join('/')
    if (name.startsWith('../') || isAbsolute(name)) throw new Error('官方插件源码路径越界')
    entries.set(name, await readFile(absolutePath))
  }
}

function assertOfficialManifest(manifest) {
  if (
    manifest.id !== 'streamfold.webhook' ||
    manifest.version !== '1.0.0' ||
    manifest.publisher.id !== 'streamfold' ||
    manifest.publisher.keyId !== 'streamfold-official' ||
    manifest.contributions.length !== 3 ||
    manifest.contributions.some((contribution) => contribution.runtime !== 'quickjs')
  ) {
    throw new Error('官方 Webhook 插件清单身份或运行时不符合发布约束')
  }
}

function parseTrustDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('官方 Webhook 信任信息无效')
  const keys = [
    'schemaVersion', 'pluginId', 'version', 'packageFile', 'packageHash', 'contentHash',
    'publisherKeyId', 'publisherPublicKey'
  ]
  if (value.schemaVersion !== 1 || Object.keys(value).sort().join() !== [...keys].sort().join()) {
    throw new Error('官方 Webhook 信任信息结构无效')
  }
  for (const key of keys.slice(1)) {
    if (typeof value[key] !== 'string' || value[key].length === 0) throw new Error('官方 Webhook 信任信息字段无效')
  }
  if (!/^streamfold\.webhook-\d+\.\d+\.\d+\.streamfold-plugin$/.test(value.packageFile)) {
    throw new Error('官方 Webhook 资源文件名无效')
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(value.packageHash) || !/^sha256:[a-f0-9]{64}$/.test(value.contentHash)) {
    throw new Error('官方 Webhook 固定摘要无效')
  }
  return value
}

function generatedTrustModule(trust) {
  return `// Generated by scripts/build-official-webhook.mjs. Do not edit manually.\n` +
    `export const OFFICIAL_WEBHOOK_PACKAGE_TRUST = Object.freeze(${JSON.stringify({
      pluginId: trust.pluginId,
      version: trust.version,
      packageFile: trust.packageFile,
      packageHash: trust.packageHash,
      contentHash: trust.contentHash,
      publisherKeyId: trust.publisherKeyId,
      publisherPublicKey: trust.publisherPublicKey
    }, null, 2)} as const)\n`
}

function publicKeyPem(spkiBase64) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(spkiBase64)) throw new Error('官方 Webhook 发布者公钥无效')
  const lines = spkiBase64.match(/.{1,64}/g) ?? []
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`
}

function parseArguments(values) {
  const result = new Map()
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith('--')) throw new Error(`未知参数：${value}`)
    const key = value.slice(2)
    const next = values[index + 1]
    if (next && !next.startsWith('--')) {
      result.set(key, next)
      index += 1
    } else {
      result.set(key, true)
    }
  }
  return result
}

function stringArgument(name) {
  const value = argumentsMap.get(name)
  if (value === true) throw new Error(`--${name} 需要参数`)
  return value
}

function booleanArgument(name) {
  const value = argumentsMap.get(name)
  if (value === undefined) return false
  if (value !== true) throw new Error(`--${name} 不接受参数`)
  return true
}

async function pathExists(path) {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}
