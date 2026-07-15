import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const verifierPath = fileURLToPath(new URL('./verify-update-artifacts.mjs', import.meta.url))
const packageVersion = (JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string }).version
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('update artifact verifier', () => {
  it('accepts an AppImage with an embedded blockmap', async () => {
    const fixture = await createFixture({ externalBlockmap: false })

    const { stdout } = await verifyFixture(fixture, false)

    expect(stdout).toContain('更新资产校验通过：latest-linux.yml')
    expect(stdout).toContain('0 个 blockmap')
  })

  it('verifies an external blockmap when the target requires one', async () => {
    const fixture = await createFixture({ externalBlockmap: true })

    const { stdout } = await verifyFixture(fixture, true)

    expect(stdout).toContain('1 个 blockmap')
  })

  it('rejects a missing external blockmap when the target requires one', async () => {
    const fixture = await createFixture({ externalBlockmap: false })

    await expect(verifyFixture(fixture, true)).rejects.toMatchObject({
      stderr: expect.stringContaining('.AppImage.blockmap')
    })
  })
})

async function createFixture(options: { externalBlockmap: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'streamfold-update-artifacts-'))
  temporaryDirectories.push(root)

  const artifactName = `Streamfold-${packageVersion}-linux-x86_64.AppImage`
  const artifact = Buffer.alloc(1_024, 0x41)
  const blockmap = Buffer.alloc(128, 0x42)
  const sha512 = createHash('sha512').update(artifact).digest('base64')
  const manifest = {
    version: packageVersion,
    files: [{ url: artifactName, sha512, size: artifact.byteLength, blockMapSize: blockmap.byteLength }],
    path: artifactName,
    sha512
  }

  await writeFile(join(root, artifactName), artifact)
  await writeFile(join(root, 'latest-linux.yml'), JSON.stringify(manifest))
  if (options.externalBlockmap) await writeFile(join(root, `${artifactName}.blockmap`), blockmap)

  const resources = join(root, 'linux-unpacked', 'resources')
  await mkdir(resources, { recursive: true })
  await writeFile(
    join(resources, 'app-update.yml'),
    JSON.stringify({ provider: 'github', owner: 'nzmxd', repo: 'streamfold' })
  )
  return root
}

async function verifyFixture(releaseDirectory: string, requireExternalBlockmap: boolean) {
  return execute(process.execPath, [verifierPath], {
    env: {
      ...process.env,
      RELEASE_DIR: releaseDirectory,
      UPDATE_MANIFEST: 'latest-linux.yml',
      UPDATE_PROVIDER_OWNER: 'nzmxd',
      UPDATE_PROVIDER_REPO: 'streamfold',
      REQUIRE_EXTERNAL_BLOCKMAP: String(requireExternalBlockmap)
    }
  })
}
