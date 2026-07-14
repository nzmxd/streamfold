#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as parseYaml } from 'js-yaml'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const releaseDirectory = resolve(process.env.RELEASE_DIR ?? join(repositoryRoot, 'release'))
const manifestName = requiredEnvironment('UPDATE_MANIFEST')
const expectedOwner = requiredEnvironment('UPDATE_PROVIDER_OWNER')
const expectedRepository = requiredEnvironment('UPDATE_PROVIDER_REPO')
const requireExternalBlockmap = process.env.REQUIRE_EXTERNAL_BLOCKMAP === 'true'

if (basename(manifestName) !== manifestName || !/^latest(?:-[a-z]+)?\.yml$/.test(manifestName)) {
  throw new Error(`更新清单文件名无效：${manifestName}`)
}

const packageJson = objectValue(JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')), 'package.json')
const packageVersion = stringValue(packageJson.version, 'package.json version')
const manifestPath = join(releaseDirectory, manifestName)
const manifest = await readYamlObject(manifestPath, '更新清单')

if (manifest.version !== packageVersion) {
  throw new Error(`更新清单版本 ${String(manifest.version)} 与 package.json ${packageVersion} 不一致`)
}

if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
  throw new Error(`${manifestName} 没有可下载文件`)
}

const verifiedFiles = new Map()
let verifiedBlockmaps = 0
for (const [index, value] of manifest.files.entries()) {
  const entry = objectValue(value, `files[${index}]`)
  const fileName = safeArtifactName(stringValue(entry.url, `files[${index}].url`))
  const expectedSha512 = sha512Value(entry.sha512, `files[${index}].sha512`)
  const expectedSize = positiveInteger(entry.size, `files[${index}].size`)
  const artifactPath = join(releaseDirectory, fileName)
  const artifactStat = await stat(artifactPath)
  if (!artifactStat.isFile()) throw new Error(`更新资产不是文件：${fileName}`)
  if (artifactStat.size !== expectedSize) {
    throw new Error(`更新资产大小不匹配：${fileName}，清单 ${expectedSize}，实际 ${artifactStat.size}`)
  }
  const actualSha512 = await sha512File(artifactPath)
  if (actualSha512 !== expectedSha512) throw new Error(`更新资产 SHA-512 不匹配：${fileName}`)
  verifiedFiles.set(fileName, expectedSha512)

  if (requireExternalBlockmap || entry.blockMapSize !== undefined) {
    const blockmapName = `${fileName}.blockmap`
    const blockmapStat = await stat(join(releaseDirectory, blockmapName))
    if (!blockmapStat.isFile() || blockmapStat.size <= 0) {
      throw new Error(`外部 blockmap 无效：${blockmapName}`)
    }
    if (entry.blockMapSize !== undefined) {
      const expectedBlockmapSize = positiveInteger(entry.blockMapSize, `files[${index}].blockMapSize`)
      if (blockmapStat.size !== expectedBlockmapSize) {
        throw new Error(`外部 blockmap 大小不匹配：${blockmapName}`)
      }
    }
    verifiedBlockmaps += 1
  }
}

if (requireExternalBlockmap && verifiedBlockmaps === 0) {
  throw new Error(`${manifestName} 没有声明外部 blockmap`)
}

const primaryPath = safeArtifactName(stringValue(manifest.path, 'path'))
const primarySha512 = sha512Value(manifest.sha512, 'sha512')
if (verifiedFiles.get(primaryPath) !== primarySha512) {
  throw new Error(`主更新资产 ${primaryPath} 未出现在 files 中或摘要不一致`)
}

const appUpdateFiles = await findFiles(releaseDirectory, 'app-update.yml', 8)
if (appUpdateFiles.length === 0) throw new Error('安装目录中缺少 resources/app-update.yml')
for (const appUpdatePath of appUpdateFiles) {
  const source = await readYamlObject(appUpdatePath, 'app-update.yml')
  if (source.provider !== 'github' || source.owner !== expectedOwner || source.repo !== expectedRepository) {
    throw new Error(
      `app-update.yml 更新源错误：期望 github/${expectedOwner}/${expectedRepository}，` +
      `实际 ${String(source.provider)}/${String(source.owner)}/${String(source.repo)}`
    )
  }
}

process.stdout.write(
  `更新资产校验通过：${manifestName}，${verifiedFiles.size} 个文件，` +
  `${verifiedBlockmaps} 个 blockmap，${appUpdateFiles.length} 个 app-update.yml\n`
)

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

async function readYamlObject(path, label) {
  return objectValue(parseYaml(await readFile(path, 'utf8')), label)
}

function objectValue(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`)
  }
  return value
}

function stringValue(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 必须是非空字符串`)
  return value.trim()
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 必须是正整数`)
  return value
}

function sha512Value(value, label) {
  const encoded = stringValue(value, label)
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.byteLength !== 64 || decoded.toString('base64') !== encoded) {
    throw new Error(`${label} 不是规范的 SHA-512 Base64`)
  }
  return encoded
}

function safeArtifactName(value) {
  let decoded
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new Error(`更新资产名称编码无效：${value}`)
  }
  if (decoded !== basename(decoded) || decoded === '.' || decoded === '..' || /[\\/\0]/.test(decoded)) {
    throw new Error(`更新资产名称不安全：${value}`)
  }
  return decoded
}

async function sha512File(path) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('base64')
}

async function findFiles(root, name, depth) {
  if (depth < 0) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const matches = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name === name) matches.push(path)
    else if (entry.isDirectory()) matches.push(...await findFiles(path, name, depth - 1))
  }
  return matches
}
