#!/usr/bin/env node
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginManifestV2 } from './contracts.js'
import { createManifest } from './manifest.js'
import {
  PLUGIN_PACKAGE_EXTENSION,
  createPluginPackageSignature,
  readPluginArchive,
  validatePluginEntries,
  verifyPluginArchive,
  writePluginArchive
} from './package-format.js'

export interface CliIo {
  stdout(message: string): void
  stderr(message: string): void
}

const defaultIo: CliIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`)
}

export async function runCli(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  try {
    const [command, ...rest] = argv
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      io.stdout(helpText())
      return 0
    }
    const args = parseArgs(rest)
    if (command === 'init') await initPlugin(args, io)
    else if (command === 'validate') await validateCommand(args, io)
    else if (command === 'pack') await packCommand(args, io)
    else if (command === 'keygen') await keygenCommand(args, io)
    else if (command === 'sign') await signCommand(args, io)
    else if (command === 'verify') await verifyCommand(args, io)
    else throw new Error(`未知命令：${command}`)
    return 0
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : '插件命令执行失败')
    return 1
  }
}

interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | true>
}

async function initPlugin(args: ParsedArgs, io: CliIo): Promise<void> {
  const destination = resolve(args.positionals[0] ?? requiredFlag(args, 'dir'))
  const existing = await pathExists(destination)
  if (existing) {
    const metadata = await stat(destination)
    if (!metadata.isDirectory() || (await readdir(destination)).length > 0) {
      throw new Error(`目标目录不是空目录：${destination}`)
    }
  } else {
    await mkdir(destination, { recursive: true })
  }
  const id = flag(args, 'id') ?? slug(basename(destination))
  const name = flag(args, 'name') ?? id
  const publisherId = flag(args, 'publisher-id') ?? 'local.publisher'
  const publisherName = flag(args, 'publisher-name') ?? 'Local Publisher'
  const keyId = flag(args, 'key-id') ?? `${publisherId}.main`
  const manifest = createManifest({
    id,
    name,
    version: '0.1.0',
    description: `${name} 第三方插件`,
    license: 'MIT',
    publisher: { id: publisherId, name: publisherName, keyId },
    minimumAppVersion: '0.5.0',
    contributions: [{
      id: `${id}.action`,
      kind: 'action',
      name: `${name} 动作`,
      description: '在插件中心运行的示例动作。',
      entry: 'entries/action.js',
      runtime: 'quickjs',
      permissions: [],
      placements: ['plugin-center']
    }]
  })
  await mkdir(join(destination, 'entries'), { recursive: true })
  await writeNew(join(destination, 'manifest.json'), jsonFile(manifest))
  await writeNew(join(destination, 'entries', 'action.js'), scaffoldEntry(name))
  await writeNew(join(destination, 'README.md'), scaffoldReadme(name))
  io.stdout(`已创建插件：${destination}`)
}

async function validateCommand(args: ParsedArgs, io: CliIo): Promise<void> {
  const source = resolve(args.positionals[0] ?? '.')
  const entries = await loadSourceEntries(source)
  const result = validatePluginEntries(entries)
  io.stdout(`验证通过：${result.manifest.id}@${result.manifest.version}（${result.entries.size} 个文件）`)
}

async function packCommand(args: ParsedArgs, io: CliIo): Promise<void> {
  const source = resolve(args.positionals[0] ?? '.')
  const entries = await loadDirectoryEntries(await sourceDirectory(source))
  entries.delete('signature.json')
  const validated = validatePluginEntries(entries)
  const output = resolveOutput(
    flag(args, 'out'),
    join(source, 'dist', `${validated.manifest.id}-${validated.manifest.version}${PLUGIN_PACKAGE_EXTENSION}`)
  )
  await mkdir(dirname(output), { recursive: true })
  await writeNew(output, writePluginArchive(entries))
  io.stdout(`已打包：${output}`)
}

async function keygenCommand(args: ParsedArgs, io: CliIo): Promise<void> {
  const outputDirectory = resolve(flag(args, 'out-dir') ?? args.positionals[0] ?? '.')
  const prefix = flag(args, 'name') ?? 'publisher'
  const keyId = flag(args, 'key-id') ?? `${prefix}.main`
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])?$/.test(keyId)) throw new Error('密钥 ID 非法')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePath = join(outputDirectory, `${prefix}-private.pem`)
  const publicPath = join(outputDirectory, `${prefix}-public.pem`)
  await mkdir(outputDirectory, { recursive: true })
  await writeNew(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, 0o600)
  await writeNew(publicPath, publicKey.export({ format: 'pem', type: 'spki' }) as string)
  io.stdout(`已生成 Ed25519 密钥（${keyId}）：${publicPath}`)
  io.stdout(`私钥仅保存在本机：${privatePath}`)
}

async function signCommand(args: ParsedArgs, io: CliIo): Promise<void> {
  const source = resolve(args.positionals[0] ?? requiredFlag(args, 'source'))
  const privateKeyPath = resolve(requiredFlag(args, 'key'))
  const entries = await loadSourceEntries(source)
  entries.delete('signature.json')
  const validated = validatePluginEntries(entries)
  const privateKey = await readFile(privateKeyPath)
  let signature
  try {
    signature = createPluginPackageSignature(entries, validated.manifest.publisher.keyId, privateKey)
  } finally {
    privateKey.fill(0)
  }
  entries.set('signature.json', Buffer.from(jsonFile(signature), 'utf8'))
  const defaultOutput = (await isDirectory(source))
    ? join(source, 'dist', `${validated.manifest.id}-${validated.manifest.version}.signed${PLUGIN_PACKAGE_EXTENSION}`)
    : join(dirname(source), `${basename(source, extname(source))}.signed${PLUGIN_PACKAGE_EXTENSION}`)
  const output = resolveOutput(flag(args, 'out'), defaultOutput)
  await mkdir(dirname(output), { recursive: true })
  await writeNew(output, writePluginArchive(entries))
  io.stdout(`已签名：${output}`)
}

async function verifyCommand(args: ParsedArgs, io: CliIo): Promise<void> {
  const source = resolve(args.positionals[0] ?? requiredFlag(args, 'source'))
  const publicKeyPath = resolve(requiredFlag(args, 'public-key'))
  if (extname(source).toLowerCase() !== PLUGIN_PACKAGE_EXTENSION) throw new Error('请选择 .streamfold-plugin 插件包')
  const result = await verifyPluginArchive(await readFile(source), {
    publicKey: await readFile(publicKeyPath),
    expectedKeyId: flag(args, 'key-id'),
    requireSignature: true
  })
  io.stdout(`签名有效：${result.manifest.id}@${result.manifest.version}`)
  io.stdout(`包摘要：${result.archiveHash}`)
}

async function loadSourceEntries(source: string): Promise<Map<string, Buffer>> {
  if (await isDirectory(source)) return loadDirectoryEntries(source)
  if (basename(source).toLowerCase() === 'manifest.json') return loadDirectoryEntries(dirname(source))
  if (extname(source).toLowerCase() !== PLUGIN_PACKAGE_EXTENSION) {
    throw new Error('源必须是插件目录、manifest.json 或 .streamfold-plugin 文件')
  }
  return readPluginArchive(await readFile(source))
}

async function sourceDirectory(source: string): Promise<string> {
  if (!(await isDirectory(source))) throw new Error('pack 命令需要插件源码目录')
  return source
}

async function loadDirectoryEntries(root: string): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>()
  await addRequiredFile(entries, root, 'manifest.json')
  for (const name of ['README', 'README.md', 'README.txt', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'signature.json']) {
    if (await pathExists(join(root, name))) await addRequiredFile(entries, root, name)
  }
  for (const directory of ['entries', 'icons']) {
    const fullPath = join(root, directory)
    if (await pathExists(fullPath)) await collectDirectory(entries, root, fullPath)
  }
  return entries
}

async function collectDirectory(entries: Map<string, Buffer>, root: string, directory: string): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, item.name)
    if (item.isSymbolicLink()) throw new Error(`插件源码不允许符号链接：${fullPath}`)
    if (item.isDirectory()) await collectDirectory(entries, root, fullPath)
    else if (item.isFile()) await addRequiredFile(entries, root, relative(root, fullPath).split(sep).join('/'))
  }
}

async function addRequiredFile(entries: Map<string, Buffer>, root: string, name: string): Promise<void> {
  const filePath = resolve(root, name)
  const rel = relative(root, filePath)
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('插件文件超出源码目录')
  const metadata = await lstat(filePath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`插件条目必须是普通文件：${name}`)
  entries.set(name.split(sep).join('/'), await readFile(filePath))
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!
    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }
    const equals = value.indexOf('=')
    if (equals > 2) {
      flags.set(value.slice(2, equals), value.slice(equals + 1))
      continue
    }
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next)
      index += 1
    } else {
      flags.set(key, true)
    }
  }
  return { positionals, flags }
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name)
  if (value === true) throw new Error(`--${name} 需要参数`)
  return value
}

function requiredFlag(args: ParsedArgs, name: string): string {
  const value = flag(args, name)
  if (!value) throw new Error(`缺少 --${name}`)
  return value
}

function resolveOutput(value: string | undefined, fallback: string): string {
  return resolve(value ?? fallback)
}

async function writeNew(path: string, value: string | Uint8Array, mode?: number): Promise<void> {
  try {
    await writeFile(path, value, { flag: 'wx', ...(mode === undefined ? {} : { mode }) })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`拒绝覆盖已有文件：${path}`)
    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
  if (!normalized || normalized.length < 3) throw new Error('无法从目录名生成合法插件 ID，请传入 --id')
  return normalized.slice(0, 128)
}

function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function scaffoldEntry(name: string): string {
  return `'use strict'\n\nmodule.exports = {\n  async run(context, input) {\n    return {\n      ok: true,\n      pluginId: context.pluginId || null,\n      message: ${JSON.stringify(`${name} 已运行`)},\n      input: input === undefined ? null : input\n    }\n  }\n}\n`
}

function scaffoldReadme(name: string): string {
  return `# ${name}\n\n归页第三方插件。\n\n- 校验：\`streamfold-plugin validate .\`\n- 打包：\`streamfold-plugin pack .\`\n- 签名：\`streamfold-plugin sign <package> --key <private.pem>\`\n`
}

function helpText(): string {
  return `Streamfold Plugin CLI\n\n` +
    `用法：streamfold-plugin <command> [options]\n\n` +
    `  init <dir>                创建动作插件骨架\n` +
    `  validate <source>         校验目录、manifest 或插件包\n` +
    `  pack <dir> [--out file]   创建未签名开发包\n` +
    `  keygen [--out-dir dir]    生成 Ed25519 发布密钥\n` +
    `  sign <source> --key file  创建发布者签名包\n` +
    `  verify <file> --public-key file  验证签名与内容摘要\n`
}

const directEntry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (directEntry === import.meta.url) {
  void runCli(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
