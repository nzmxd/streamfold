import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validatePluginManifestV2 } from '../../../src/shared/plugin-host-contracts'
import { verifyPluginPackage } from '../../../src/main/plugins/plugin-package'
import {
  createManifest,
  createPluginPackageSignature,
  createTestHost,
  type PlatformAdapterCollectInput,
  type PlatformAdapterContributionModule,
  type PlatformAdapterReadIdentityInput,
  validateManifest,
  validatePluginEntries,
  verifyPluginArchive,
  writePluginArchive
} from '../src/index'
import { runCli } from '../src/cli'

const temporaryDirectories: string[] = []
const sampleDirectory = resolve('examples/plugins/hello-action')

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Streamfold plugin SDK', () => {
  it('exposes the host platform adapter input contracts', () => {
    const identityInput: PlatformAdapterReadIdentityInput = { expectedRemoteId: null }
    const collectInput: PlatformAdapterCollectInput = { scope: 'recent_100', boundRemoteId: 'owner-1' }
    const moduleIdentityInput: Parameters<PlatformAdapterContributionModule['readIdentity']>[1] = identityInput
    const moduleCollectInput: Parameters<PlatformAdapterContributionModule['collect']>[1] = collectInput

    expect(moduleIdentityInput).toEqual({ expectedRemoteId: null })
    expect(moduleCollectInput).toEqual({ scope: 'recent_100', boundRemoteId: 'owner-1' })
  })

  it('builds manifests accepted by the application host', () => {
    const manifest = createManifest({
      id: 'community.example',
      name: 'Example',
      version: '1.0.0',
      description: 'Example action plugin',
      license: 'MIT',
      publisher: { id: 'community.publisher', name: 'Community', keyId: 'community.publisher.main' },
      minimumAppVersion: '0.5.0',
      contributions: [{
        id: 'community.example.action',
        kind: 'action',
        name: 'Run example',
        description: 'Runs the example',
        entry: 'entries/action.js',
        runtime: 'quickjs',
        permissions: [],
        placements: ['plugin-center']
      }]
    })

    expect(validatePluginManifestV2(manifest)).toEqual(manifest)
    expect(() => validateManifest({
      ...manifest,
      contributions: [{ ...manifest.contributions[0], runtime: 'node' }]
    })).toThrow()
  })

  it('keeps platform URL declarations and camelCase config keys compatible with the host', () => {
    const manifest = createManifest({
      id: 'community.platform-example',
      name: 'Platform example',
      version: '0.5.0',
      description: 'Platform adapter contract example',
      license: 'MIT',
      publisher: { id: 'community.publisher', name: 'Community', keyId: 'community.publisher.main' },
      minimumAppVersion: '0.5.0',
      contributions: [{
        id: 'community.platform-example.adapter',
        kind: 'platform.adapter',
        name: 'Example adapter',
        description: 'Reads example platform data',
        entry: 'entries/adapter.js',
        runtime: 'quickjs',
        permissions: ['platform.session-json'],
        configSchema: {
          type: 'object',
          properties: {
            apiToken: { type: 'string', title: 'API token', format: 'secret' }
          },
          required: ['apiToken'],
          additionalProperties: false
        },
        platform: {
          id: 'example.social',
          name: 'Example Social',
          shortName: 'EX',
          loginUrl: 'https://example.com/login',
          homeUrl: 'https://example.com/',
          navigationHosts: ['example.com'],
          imageHosts: ['images.example.com'],
          contentUrls: [{
            remoteIdTemplate: 'post:{postId}',
            origin: 'https://example.com',
            pathTemplate: '/posts/{postId}',
            queryParameters: ['source']
          }],
          riskNote: 'Use the signed-in account session.'
        },
        endpoints: [],
        captures: [{
          id: 'profile.capture',
          route: 'https://example.com/i/user/{userId}?source=official',
          responseOrigin: 'https://api.example.com',
          responsePath: '/graphql',
          graphqlOperationName: 'UserContents',
          resourceTypes: ['Fetch', 'XHR'],
          method: 'GET'
        }],
        backgroundCapture: {
          captures: [{
            captureId: 'profile.capture',
            responseFieldPaths: ['/data/user/id', '/data/user/name'],
            responseCorrelations: [{
              routeParameter: 'userId',
              responseFieldPaths: ['/data/user/id'],
              comparison: 'exact'
            }]
          }],
          cacheTtlSeconds: 120,
          retryIntervalSeconds: 2,
          maximumRetryIntervalSeconds: 60,
          identityDiscovery: {
            strategy: 'on-capture',
            captureIds: ['profile.capture']
          }
        },
        minimumIntervalSeconds: 60,
        recommendedSyncIntervalHours: 24
      }]
    })

    expect(validatePluginManifestV2(manifest)).toEqual(manifest)
    const contribution = manifest.contributions[0]!
    if (contribution.kind !== 'platform.adapter') throw new Error('expected platform adapter')
    expect(contribution.captures[0]).toMatchObject({
      route: 'https://example.com/i/user/{userId}?source=official',
      graphqlOperationName: 'UserContents'
    })
    expect(contribution.backgroundCapture?.captures[0]).toMatchObject({
      captureId: 'profile.capture',
      responseCorrelations: [{ routeParameter: 'userId', comparison: 'exact' }]
    })
    for (const path of [
      '/auth', '/auth_code', '/sig', '/session_key', '/client_session_key',
      '/access_key', '/oauth_nonce', '/laravel_session', '/PHPSESSID',
      '/connect_sid', '/__Secure-3PSIDTS', '/data/*'
    ]) {
      const invalidBackground = {
        ...manifest,
        contributions: [{
          ...contribution,
          backgroundCapture: {
            ...contribution.backgroundCapture!,
            captures: [{
              captureId: 'profile.capture',
              responseFieldPaths: [path],
              responseCorrelations: [{
                routeParameter: 'userId',
                responseFieldPaths: [path],
                comparison: 'exact'
              }]
            }]
          }
        }]
      }
      expect(() => validateManifest(invalidBackground)).toThrow('敏感字段')
      expect(() => validatePluginManifestV2(invalidBackground)).toThrow('敏感字段')
    }
    expect(() => validateManifest({
      ...manifest,
      contributions: [{
        ...manifest.contributions[0],
        platform: {
          ...(manifest.contributions[0] as { platform: Record<string, unknown> }).platform,
          contentUrls: [{
            remoteIdTemplate: 'post:{postId}',
            origin: 'https://example.com',
            pathTemplate: '/posts/{differentId}'
          }]
        }
      }]
    })).toThrow('原帖 URL 模板参数不一致')

    for (const route of [
      'https://{host}/i/user/user-1',
      'https://example.com:444/i/user/user-1',
      'https://example.com:443/i/user/user-1',
      'https://example.com/i/user/user-1?mode={private}',
      'https://example.com/i/user/user-1?mode=one&mode=two',
      'https://example.com/i/user/user-1#profile'
    ]) {
      const invalid = {
        ...manifest,
        contributions: [{
          ...contribution,
          captures: [{ ...contribution.captures[0]!, route }]
        }]
      }
      expect(() => validateManifest(invalid)).toThrow()
      expect(() => validatePluginManifestV2(invalid)).toThrow()
    }

    const invalidOperation = {
      ...manifest,
      contributions: [{
        ...contribution,
        captures: [{
          ...contribution.captures[0]!,
          graphqlOperationName: 'UserContents/private'
        }]
      }]
    }
    expect(() => validateManifest(invalidOperation)).toThrow('GraphQL 操作名称非法')
    expect(() => validatePluginManifestV2(invalidOperation)).toThrow('GraphQL 操作名称非法')

    const templatedGraphqlPrefix = {
      ...manifest,
      contributions: [{
        ...contribution,
        captures: [{
          ...contribution.captures[0]!,
          responsePath: '/graphql/{userId}'
        }]
      }]
    }
    expect(() => validateManifest(templatedGraphqlPrefix)).toThrow('GraphQL 响应路径必须是固定前缀')
    expect(() => validatePluginManifestV2(templatedGraphqlPrefix)).toThrow('GraphQL 响应路径必须是固定前缀')
  })

  it('creates signed archives accepted by the application package verifier', async () => {
    const entries = await sampleEntries()
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const manifest = validatePluginEntries(entries).manifest
    entries.set('signature.json', Buffer.from(JSON.stringify(createPluginPackageSignature(
      entries,
      manifest.publisher.keyId,
      privateKey
    ))))
    const archive = writePluginArchive(entries)
    const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()

    const sdkVerified = await verifyPluginArchive(archive, { publicKey: publicPem })
    const hostVerified = await verifyPluginPackage(archive, {
      source: 'catalog',
      publisherPublicKey: publicPem,
      expectedPublisherKeyId: manifest.publisher.keyId
    })

    expect(sdkVerified.contentHash).toBe(hostVerified.contentHash)
    expect(hostVerified.manifest.id).toBe('community.hello-action')
  })

  it('runs the third-party sample against the minimal test host', async () => {
    const host = createTestHost({
      hostCall: async (operation) => operation === 'data.read'
        ? [{ id: 'account-1' }, { id: 'account-2' }]
        : null
    })
    const output = await host.invoke({
      entrySource: await readFile(join(sampleDirectory, 'entries/action.js'), 'utf8'),
      context: { pluginId: 'community.hello-action', contributionId: 'community.hello-action.run' },
      input: { name: '测试用户' }
    })

    expect(output).toEqual({
      ok: true,
      pluginId: 'community.hello-action',
      message: '你好，测试用户！已读取 2 个授权账号摘要。'
    })
    expect(host.calls).toEqual([{
      operation: 'data.read',
      payload: { resource: 'accounts', query: { limit: 3 } }
    }])
  })

  it('supports init, validate, pack, keygen, sign and verify end to end', async () => {
    const root = await mkdtemp(join(tmpdir(), 'streamfold-sdk-'))
    temporaryDirectories.push(root)
    const plugin = join(root, 'cli-plugin')
    const unsigned = join(root, 'plugin.streamfold-plugin')
    const signed = join(root, 'plugin.signed.streamfold-plugin')
    const keys = join(root, 'keys')
    const output: string[] = []
    const errors: string[] = []
    const io = { stdout: (value: string) => output.push(value), stderr: (value: string) => errors.push(value) }

    expect(await runCli(['init', plugin, '--id', 'community.cli-plugin'], io)).toBe(0)
    expect(await runCli(['validate', plugin], io)).toBe(0)
    expect(await runCli(['pack', plugin, '--out', unsigned], io)).toBe(0)
    expect(await runCli(['keygen', '--out-dir', keys, '--name', 'test', '--key-id', 'local.publisher.main'], io)).toBe(0)
    expect(await runCli(['sign', unsigned, '--key', join(keys, 'test-private.pem'), '--out', signed], io)).toBe(0)
    expect(await runCli(['verify', signed, '--public-key', join(keys, 'test-public.pem')], io)).toBe(0)
    expect(errors).toEqual([])
    expect(output.some((line) => line.includes('签名有效'))).toBe(true)
  })
})

async function sampleEntries(): Promise<Map<string, Buffer>> {
  return new Map([
    ['manifest.json', await readFile(join(sampleDirectory, 'manifest.json'))],
    ['entries/action.js', await readFile(join(sampleDirectory, 'entries/action.js'))],
    ['README.md', await readFile(join(sampleDirectory, 'README.md'))]
  ])
}
