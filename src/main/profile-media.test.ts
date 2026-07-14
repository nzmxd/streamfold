import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROFILE_AVATAR_MAX_BYTES,
  ProfileMediaStore,
  type ProfileMediaFetcher
} from './profile-media'

const firstAccount = '11111111-1111-4111-8111-111111111111'
const secondAccount = '22222222-2222-4222-8222-222222222222'
const source = 'https://sns-avatar-qc.xhscdn.com/avatar.png?imageView2=1'
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9])

describe('ProfileMediaStore', () => {
  let directory: string
  let store: ProfileMediaStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'streamfold-profile-media-'))
    store = new ProfileMediaStore(join(directory, 'profile-media'), 2_000)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('stores verified images and cleans old avatars only after the caller commits the new key', async () => {
    const first = await store.cacheAvatar(firstAccount, source, responseFetcher(png, 'image/png'))
    const expectedHash = createHash('sha256').update(png).digest('hex')
    expect(first).toEqual({ cacheKey: `${expectedHash}.png`, mime: 'image/png' })

    const asset = await store.readAppUrl(
      `app://shell/media/avatars/${firstAccount}/${first.cacheKey}`
    )
    expect(asset).toMatchObject({ accountId: firstAccount, cacheKey: first.cacheKey, mime: 'image/png' })
    expect(asset?.bytes).toEqual(png)

    const second = await store.cacheAvatar(
      firstAccount,
      'https://sns-avatar-qc.xhscdn.com/avatar.jpg',
      responseFetcher(jpeg, 'image/jpeg')
    )
    expect(second.cacheKey).toMatch(/^[0-9a-f]{64}\.jpg$/)
    expect((await readdir(join(directory, 'profile-media', 'avatars', firstAccount))).sort())
      .toEqual([first.cacheKey, second.cacheKey].sort())

    await store.pruneAccountAvatars(firstAccount, second.cacheKey)
    expect(await readdir(join(directory, 'profile-media', 'avatars', firstAccount)))
      .toEqual([second.cacheKey])
  })

  it('accepts only HTTPS platform image hosts without credentials or a non-default port', async () => {
    const fetcher = responseFetcher(png, 'image/png')
    for (const value of [
      'http://sns-avatar-qc.xhscdn.com/a.png',
      'https://xhscdn.com.evil.example/a.png',
      'https://user:secret@xhscdn.com/a.png',
      'https://xhscdn.com:443/a.png',
      'https://xhscdn.com:444/a.png',
      'https://127.0.0.1/a.png'
    ]) {
      await expect(store.cacheAvatar(firstAccount, value, fetcher)).rejects.toThrow('允许的平台域名')
    }
    await expect(store.cacheAvatar('../escape', source, fetcher)).rejects.toThrow('账号 ID')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('validates every redirect and never sends session credentials', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher: ProfileMediaFetcher = vi.fn(async (url, init) => {
      calls.push({ url, init })
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://ci.xiaohongshu.com/avatar/final.png' }
        })
      }
      return imageResponse(png, 'image/png')
    })

    await expect(store.cacheAvatar(firstAccount, source, fetcher)).resolves.toMatchObject({ mime: 'image/png' })
    expect(calls.map((item) => item.url)).toEqual([
      source,
      'https://ci.xiaohongshu.com/avatar/final.png'
    ])
    for (const { init } of calls) {
      expect(init).toMatchObject({
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        cache: 'no-store',
        referrerPolicy: 'no-referrer'
      })
    }

    const unsafeRedirect = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://evil.example/avatar.png' }
    }))
    await expect(store.cacheAvatar(secondAccount, source, unsafeRedirect))
      .rejects.toThrow('允许的平台域名')
    expect(unsafeRedirect).toHaveBeenCalledOnce()
  })

  it('accepts only explicitly listed Zhihu avatar CDN hosts and same-platform redirects', async () => {
    const zhihuSource = 'https://picx.zhimg.com/v2-avatar.png?source=account_card'
    const calls: string[] = []
    const fetcher: ProfileMediaFetcher = vi.fn(async (url) => {
      calls.push(url)
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://pic1.zhimg.com/v2-avatar.png' }
        })
      }
      return imageResponse(png, 'image/png')
    })

    await expect(store.cacheAvatar(firstAccount, zhihuSource, fetcher))
      .resolves.toMatchObject({ mime: 'image/png' })
    expect(calls).toEqual([
      zhihuSource,
      'https://pic1.zhimg.com/v2-avatar.png'
    ])

    for (const value of [
      'https://zhimg.com/avatar.png',
      'https://unreviewed.zhimg.com/avatar.png',
      'https://picx.zhimg.com.evil.example/avatar.png',
      'https://sub.picx.zhimg.com/avatar.png',
      'http://picx.zhimg.com/avatar.png',
      'https://user:secret@picx.zhimg.com/avatar.png',
      'https://picx.zhimg.com:443/avatar.png',
      'https://picx.zhimg.com:444/avatar.png'
    ]) {
      await expect(store.cacheAvatar(secondAccount, value, responseFetcher(png, 'image/png')))
        .rejects.toThrow('允许的平台域名')
    }

    const crossPlatformRedirect = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: source }
    }))
    await expect(store.cacheAvatar(secondAccount, zhihuSource, crossPlatformRedirect))
      .rejects.toThrow('允许的平台域名')
    expect(crossPlatformRedirect).toHaveBeenCalledOnce()
  })

  it('stops after at most three validated redirects', async () => {
    let step = 0
    const fetcher = vi.fn(async () => {
      step += 1
      return new Response(null, {
        status: 302,
        headers: { location: `https://sns-avatar-qc.xhscdn.com/redirect-${step}.png` }
      })
    })
    await expect(store.cacheAvatar(firstAccount, source, fetcher)).rejects.toThrow('重定向次数')
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('rejects unsupported MIME, oversized bodies and mismatched magic bytes', async () => {
    await expect(store.cacheAvatar(firstAccount, source, responseFetcher(png, 'image/svg+xml')))
      .rejects.toThrow('MIME')
    await expect(store.cacheAvatar(firstAccount, source, vi.fn(async () => imageResponse(
      png,
      'image/png',
      { 'content-length': String(PROFILE_AVATAR_MAX_BYTES + 1) }
    )))).rejects.toThrow('512 KiB')

    const oversized = new Uint8Array(PROFILE_AVATAR_MAX_BYTES + 1)
    oversized.set(png)
    await expect(store.cacheAvatar(firstAccount, source, vi.fn(async () => new Response(
      oversized.slice().buffer as ArrayBuffer,
      {
      status: 200,
      headers: { 'content-type': 'image/png' }
      }
    )))).rejects.toThrow('512 KiB')

    await expect(store.cacheAvatar(firstAccount, source, responseFetcher(jpeg, 'image/png')))
      .rejects.toThrow('文件头')
  })

  it.each([
    ['image/jpeg', jpeg, 'jpg'],
    ['image/png', png, 'png'],
    ['image/webp', new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), 'webp'],
    ['image/gif', new TextEncoder().encode('GIF89a-avatar'), 'gif'],
    ['image/avif', new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
      0, 0, 0, 0, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0
    ]), 'avif']
  ] as const)('accepts validated %s media', async (mime, bytes, extension) => {
    await expect(store.cacheAvatar(firstAccount, source, responseFetcher(bytes, mime)))
      .resolves.toMatchObject({ mime, cacheKey: expect.stringMatching(new RegExp(`\\.${extension}$`)) })
  })

  it('rejects media traversal and isolates purge/prune by account directory', async () => {
    const first = await store.cacheAvatar(firstAccount, source, responseFetcher(png, 'image/png'))
    const second = await store.cacheAvatar(secondAccount, source, responseFetcher(png, 'image/png'))

    for (const value of [
      `app://media/media/avatars/${firstAccount}/${first.cacheKey}`,
      `app://shell/media/avatars/${firstAccount}/../${second.cacheKey}`,
      `app://shell/media/avatars/${firstAccount}/%2e%2e/${second.cacheKey}`,
      `app://shell/media/avatars/${firstAccount}/${first.cacheKey}?source=remote`,
      `app://shell/media/avatars/${firstAccount}/${first.cacheKey}/extra`
    ]) {
      await expect(store.readAppUrl(value)).resolves.toBeNull()
    }

    await store.purgeAccount(firstAccount)
    await expect(store.readAppUrl(`app://shell/media/avatars/${firstAccount}/${first.cacheKey}`))
      .resolves.toBeNull()
    await expect(store.readAppUrl(`app://shell/media/avatars/${secondAccount}/${second.cacheKey}`))
      .resolves.toMatchObject({ accountId: secondAccount })

    await store.pruneAccounts(new Set<string>())
    await expect(store.readAppUrl(`app://shell/media/avatars/${secondAccount}/${second.cacheKey}`))
      .resolves.toBeNull()
  })
})

function responseFetcher(
  bytes: Uint8Array,
  mime: string
): ReturnType<typeof vi.fn<ProfileMediaFetcher>> {
  return vi.fn<ProfileMediaFetcher>(async () => imageResponse(bytes, mime))
}

function imageResponse(
  bytes: Uint8Array,
  mime: string,
  headers: Record<string, string> = {}
): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, {
    status: 200,
    headers: {
      'content-type': mime,
      'content-length': String(bytes.byteLength),
      ...headers
    }
  })
}
