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

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const resourceDirectory = join(repositoryRoot, 'resources', 'plugins')
const defaultPrivateKeyPath = join(repositoryRoot, '.local-plugin-signing', 'streamfold-official-private.pem')

export const OFFICIAL_PLUGIN_DEFINITIONS = Object.freeze([
  Object.freeze({
    pluginId: 'streamfold.webhook',
    version: '1.0.0',
    label: 'Webhook',
    sourceDirectory: join(repositoryRoot, 'tooling', 'builtin-plugins', 'streamfold.webhook'),
    trustModulePath: join(repositoryRoot, 'src', 'main', 'plugins', 'official-webhook-trust.generated.ts'),
    trustExportName: 'OFFICIAL_WEBHOOK_PACKAGE_TRUST',
    contributionIds: Object.freeze([
      'streamfold.webhook.test',
      'streamfold.webhook.events',
      'streamfold.webhook.schedule'
    ])
  }),
  Object.freeze({
    pluginId: 'streamfold.x',
    version: '1.1.1',
    label: 'X',
    sourceDirectory: join(repositoryRoot, 'tooling', 'builtin-plugins', 'streamfold.x'),
    trustModulePath: join(repositoryRoot, 'src', 'main', 'plugins', 'official-x-trust.generated.ts'),
    trustExportName: 'OFFICIAL_X_PACKAGE_TRUST',
    contributionIds: Object.freeze(['streamfold.x.platform'])
  })
])

export async function runOfficialPluginPackaging(rawArguments = process.argv.slice(2), options = {}) {
  const [command = 'verify', ...argumentValues] = rawArguments
  const argumentsMap = parseArguments(argumentValues)
  const definitions = selectDefinitions(argumentsMap, options.pluginIds)
  if (command === 'build') await buildPackages(definitions, argumentsMap)
  else if (command === 'verify') await verifyCommittedPackages(definitions)
  else throw new Error(`未知命令：${command}`)
}

export async function readOfficialPluginTrustDocuments(definitions = OFFICIAL_PLUGIN_DEFINITIONS) {
  return Promise.all(definitions.map(async (definition) => ({
    definition,
    trust: parseTrustDocument(
      JSON.parse(await readFile(join(definition.sourceDirectory, 'trust.json'), 'utf8')),
      definition
    )
  })))
}

async function buildPackages(definitions, argumentsMap) {
  const privateKeyPath = resolve(
    stringArgument(argumentsMap, 'private-key') ??
    process.env.STREAMFOLD_OFFICIAL_PLUGIN_PRIVATE_KEY_FILE ??
    defaultPrivateKeyPath
  )
  if (booleanArgument(argumentsMap, 'generate-local-key') && !(await pathExists(privateKeyPath))) {
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

  try {
    for (const definition of definitions) await buildPackage(definition, privateKey)
  } finally {
    privateKey = undefined
  }
  await verifyCommittedPackages(definitions)
}

async function buildPackage(definition, privateKey) {
  const entries = await loadSourceEntries(definition.sourceDirectory)
  const unsigned = validatePluginEntries(entries)
  assertOfficialManifest(unsigned.manifest, definition)
  const signature = createPluginPackageSignature(entries, unsigned.manifest.publisher.keyId, privateKey)
  entries.set('signature.json', Buffer.from(`${JSON.stringify(signature, null, 2)}\n`, 'utf8'))
  const archive = writePluginArchive(entries)
  const publicKey = createPublicKey(privateKey)
  const publicKeyPemValue = publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const publisherPublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const verified = await verifyPluginArchive(archive, {
    publicKey: publicKeyPemValue,
    expectedKeyId: unsigned.manifest.publisher.keyId,
    requireSignature: true
  })
  assertOfficialManifest(verified.manifest, definition)

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
  await writeFile(join(definition.sourceDirectory, 'trust.json'), `${JSON.stringify(trust, null, 2)}\n`, 'utf8')
  await writeFile(definition.trustModulePath, generatedTrustModule(trust, definition), 'utf8')

  process.stdout.write(`官方 ${definition.label} 插件已签名：resources/plugins/${packageFile}\n`)
  process.stdout.write(`包摘要：${verified.archiveHash}\n`)
}

async function verifyCommittedPackages(definitions) {
  for (const { definition, trust } of await readOfficialPluginTrustDocuments(definitions)) {
    const archive = await readFile(join(resourceDirectory, trust.packageFile))
    const verified = await verifyPluginArchive(archive, {
      publicKey: publicKeyPem(trust.publisherPublicKey, definition),
      expectedKeyId: trust.publisherKeyId,
      requireSignature: true
    })
    assertOfficialManifest(verified.manifest, definition)
    if (verified.manifest.id !== trust.pluginId || verified.manifest.version !== trust.version) {
      throw new Error(`官方 ${definition.label} 插件身份与固定信任信息不一致`)
    }
    if (verified.archiveHash !== trust.packageHash || verified.contentHash !== trust.contentHash) {
      throw new Error(`官方 ${definition.label} 插件摘要与固定信任信息不一致`)
    }

    const source = validatePluginEntries(await loadSourceEntries(definition.sourceDirectory))
    assertOfficialManifest(source.manifest, definition)
    if (source.contentHash !== verified.contentHash) {
      throw new Error(`官方 ${definition.label} 插件资源不是由当前源码生成`)
    }
    const generatedModule = await readFile(definition.trustModulePath, 'utf8')
    if (generatedModule !== generatedTrustModule(trust, definition)) {
      throw new Error(`主进程中的官方 ${definition.label} 信任锚不是当前资源生成的版本`)
    }
    process.stdout.write(`官方 ${definition.label} 插件校验通过：${trust.pluginId}@${trust.version}\n`)
  }
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

function assertOfficialManifest(manifest, definition) {
  const contributionIds = manifest.contributions.map((contribution) => contribution.id).sort()
  const expectedContributionIds = [...definition.contributionIds].sort()
  if (
    manifest.id !== definition.pluginId ||
    manifest.version !== definition.version ||
    manifest.publisher.id !== 'streamfold' ||
    manifest.publisher.keyId !== 'streamfold-official' ||
    contributionIds.length !== expectedContributionIds.length ||
    contributionIds.some((id, index) => id !== expectedContributionIds[index]) ||
    manifest.contributions.some((contribution) => contribution.runtime !== 'quickjs')
  ) {
    throw new Error(`官方 ${definition.label} 插件清单身份或运行时不符合发布约束`)
  }
}

function parseTrustDocument(value, definition) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`官方 ${definition.label} 信任信息无效`)
  }
  const keys = [
    'schemaVersion', 'pluginId', 'version', 'packageFile', 'packageHash', 'contentHash',
    'publisherKeyId', 'publisherPublicKey'
  ]
  if (value.schemaVersion !== 1 || Object.keys(value).sort().join() !== [...keys].sort().join()) {
    throw new Error(`官方 ${definition.label} 信任信息结构无效`)
  }
  for (const key of keys.slice(1)) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new Error(`官方 ${definition.label} 信任信息字段无效`)
    }
  }
  const expectedPackageFile = `${definition.pluginId}-${definition.version}.streamfold-plugin`
  if (
    value.pluginId !== definition.pluginId ||
    value.version !== definition.version ||
    value.packageFile !== expectedPackageFile ||
    value.publisherKeyId !== 'streamfold-official'
  ) {
    throw new Error(`官方 ${definition.label} 信任信息身份无效`)
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(value.packageHash) || !/^sha256:[a-f0-9]{64}$/.test(value.contentHash)) {
    throw new Error(`官方 ${definition.label} 固定摘要无效`)
  }
  return value
}

function generatedTrustModule(trust, definition) {
  return '// Generated by scripts/build-official-plugins.mjs. Do not edit manually.\n' +
    `export const ${definition.trustExportName} = Object.freeze(${JSON.stringify({
      pluginId: trust.pluginId,
      version: trust.version,
      packageFile: trust.packageFile,
      packageHash: trust.packageHash,
      contentHash: trust.contentHash,
      publisherKeyId: trust.publisherKeyId,
      publisherPublicKey: trust.publisherPublicKey
    }, null, 2)} as const)\n`
}

function publicKeyPem(spkiBase64, definition) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(spkiBase64)) {
    throw new Error(`官方 ${definition.label} 发布者公钥无效`)
  }
  const lines = spkiBase64.match(/.{1,64}/g) ?? []
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`
}

function selectDefinitions(argumentsMap, fixedPluginIds) {
  const requestedPluginId = stringArgument(argumentsMap, 'plugin')
  const allowed = fixedPluginIds
    ? OFFICIAL_PLUGIN_DEFINITIONS.filter((item) => fixedPluginIds.includes(item.pluginId))
    : OFFICIAL_PLUGIN_DEFINITIONS
  if (allowed.length === 0) throw new Error('没有可处理的官方插件')
  if (!requestedPluginId) return allowed
  const definition = allowed.find((item) => item.pluginId === requestedPluginId)
  if (!definition) throw new Error(`未知或不允许的官方插件：${requestedPluginId}`)
  return [definition]
}

function parseArguments(values) {
  const result = new Map()
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith('--')) throw new Error(`未知参数：${value}`)
    const key = value.slice(2)
    if (!['plugin', 'private-key', 'generate-local-key'].includes(key)) throw new Error(`未知参数：${value}`)
    if (result.has(key)) throw new Error(`参数重复：${value}`)
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

function stringArgument(argumentsMap, name) {
  const value = argumentsMap.get(name)
  if (value === true) throw new Error(`--${name} 需要参数`)
  return value
}

function booleanArgument(argumentsMap, name) {
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

const entryPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (entryPath === fileURLToPath(import.meta.url)) await runOfficialPluginPackaging()
