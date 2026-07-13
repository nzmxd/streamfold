import { describe, expect, it } from 'vitest'
import { definePinnedScript, verifyPinnedScript } from './pinned-script'
import { AdapterResultValidationError } from './validation'
import {
  XIAOHONGSHU_ADAPTER_ID,
  XIAOHONGSHU_ADAPTER_VERSION,
  XIAOHONGSHU_PROBE_SCRIPT_VERSION,
  XIAOHONGSHU_WHOAMI_SCRIPT_VERSION,
  xiaohongshuManagedBrowserAdapter
} from './xiaohongshu'

const pageUrl = 'https://creator.xiaohongshu.com/'

function probe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    operation: 'probe',
    adapterId: XIAOHONGSHU_ADAPTER_ID,
    adapterVersion: XIAOHONGSHU_ADAPTER_VERSION,
    scriptVersion: XIAOHONGSHU_PROBE_SCRIPT_VERSION,
    pageUrl,
    pageKind: 'creator',
    supported: true,
    status: 'ready',
    evidence: ['official_creator_host', 'dom_ready', 'visible_profile_link'],
    ...overrides
  }
}

function whoami(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    operation: 'whoami',
    adapterId: XIAOHONGSHU_ADAPTER_ID,
    adapterVersion: XIAOHONGSHU_ADAPTER_VERSION,
    scriptVersion: XIAOHONGSHU_WHOAMI_SCRIPT_VERSION,
    pageUrl,
    pageKind: 'creator',
    status: 'ready',
    identity: { remoteId: '645f1234567890abcdef1234', remoteName: '山茶的数字花园', profileUrl: null },
    evidence: ['official_creator_host', 'visible_profile_link', 'visible_user_id'],
    ...overrides
  }
}

describe('xiaohongshu managed-browser adapter definition', () => {
  it('exposes immutable, versioned and integrity-pinned isolated-world scripts', () => {
    const adapter = xiaohongshuManagedBrowserAdapter
    expect(adapter.metadata).toEqual({
      schemaVersion: 1,
      id: XIAOHONGSHU_ADAPTER_ID,
      version: XIAOHONGSHU_ADAPTER_VERSION,
      platformId: 'xiaohongshu',
      allowedHosts: ['creator.xiaohongshu.com'],
      readOnly: true,
      capabilities: ['probe', 'whoami']
    })

    for (const script of Object.values(adapter.scripts)) {
      expect(script.metadata.executionWorld).toBe('isolated')
      expect(script.metadata.permissions).toEqual(['location.read', 'visible_dom.read'])
      expect(script.metadata.networkAccess).toBe(false)
      expect(script.metadata.credentialAccess).toBe(false)
      expect(script.metadata.mutatesPage).toBe(false)
      expect(script.metadata.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(verifyPinnedScript(script)).toBe(true)
      expect(script.script).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB)\b/)
      expect(script.script).not.toMatch(/document\s*\.\s*cookie/)
    }

    expect(Object.isFrozen(adapter.metadata)).toBe(true)
    expect(Object.isFrozen(adapter.scripts)).toBe(true)
  })

  it('detects source tampering and blocks forbidden page capabilities', () => {
    const original = xiaohongshuManagedBrowserAdapter.scripts.probe
    expect(verifyPinnedScript({ ...original, script: `${original.script} ` })).toBe(false)
    expect(() => definePinnedScript({
      operation: 'probe',
      version: 'test-v1',
      expectedSha256: '0'.repeat(64),
      source: '(() => { fetch("https://example.test") })()'
    })).toThrowError(/禁用能力：fetch/)
  })
})

describe('xiaohongshu probe result validation', () => {
  it('accepts and freezes a complete ready result', () => {
    const result = xiaohongshuManagedBrowserAdapter.parseProbeResult(probe())
    expect(result.status).toBe('ready')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.evidence)).toBe(true)
  })

  it.each([
    ['login_required', 'login', ['official_creator_host', 'login_route']],
    ['challenge', 'creator', ['official_creator_host', 'visible_challenge']],
    ['page_not_ready', 'creator', ['official_creator_host', 'document_loading']],
    ['unsupported', 'unsupported', []]
  ] as const)('accepts the %s state with matching evidence', (status, pageKind, evidence) => {
    const result = xiaohongshuManagedBrowserAdapter.parseProbeResult(probe({
      status,
      pageKind,
      supported: status !== 'unsupported',
      evidence: [...evidence]
    }))
    expect(result.status).toBe(status)
  })

  it.each([
    probe({ extra: true }),
    probe({ adapterVersion: '0.1.1' }),
    probe({ scriptVersion: 'unreviewed' }),
    probe({ pageUrl: 'https://creator.xiaohongshu.com/?token=secret' }),
    probe({ pageUrl: 'https://creator.xiaohongshu.com.evil.test/' }),
    probe({ status: 'ready', evidence: ['official_creator_host'] }),
    probe({ status: 'challenge', evidence: ['official_creator_host'] }),
    probe({ evidence: ['visible_profile_link', 'visible_profile_link'] })
  ])('rejects malformed or semantically inconsistent output', (value) => {
    expect(() => xiaohongshuManagedBrowserAdapter.parseProbeResult(value))
      .toThrowError(AdapterResultValidationError)
  })

  it('rejects accessor-backed and non-plain renderer output', () => {
    const accessor = probe()
    Object.defineProperty(accessor, 'status', { enumerable: true, get: () => 'ready' })
    expect(() => xiaohongshuManagedBrowserAdapter.parseProbeResult(accessor))
      .toThrowError(AdapterResultValidationError)

    const inherited = Object.assign(Object.create({ polluted: true }), probe())
    expect(() => xiaohongshuManagedBrowserAdapter.parseProbeResult(inherited))
      .toThrowError(AdapterResultValidationError)
  })
})

describe('xiaohongshu whoami result validation', () => {
  it('accepts identity only when both stable id and name are present', () => {
    const result = xiaohongshuManagedBrowserAdapter.parseWhoamiResult(whoami())
    expect(result.identity).toEqual({
      remoteId: '645f1234567890abcdef1234',
      remoteName: '山茶的数字花园',
      profileUrl: null
    })
    expect(Object.isFrozen(result.identity)).toBe(true)
  })

  it.each([
    ['login_required', 'login', ['official_creator_host', 'visible_login_control']],
    ['challenge', 'creator', ['official_creator_host', 'challenge_route']],
    ['page_not_ready', 'creator', ['official_creator_host', 'document_loading']],
    ['unsupported', 'unsupported', []]
  ] as const)('accepts a non-identity %s result', (status, pageKind, evidence) => {
    const result = xiaohongshuManagedBrowserAdapter.parseWhoamiResult(whoami({
      status,
      pageKind,
      identity: null,
      evidence: [...evidence]
    }))
    expect(result.identity).toBeNull()
  })

  it.each([
    whoami({ identity: null }),
    whoami({ status: 'page_not_ready' }),
    whoami({ identity: { remoteId: 'valid-id', remoteName: null, profileUrl: null } }),
    whoami({ identity: { remoteId: 'ab', remoteName: '名字', profileUrl: null } }),
    whoami({ identity: { remoteId: 'valid-id', remoteName: 'x'.repeat(81), profileUrl: null } }),
    whoami({ identity: { remoteId: 'valid-id', remoteName: '名字', profileUrl: 'https://www.xiaohongshu.com/user/profile/valid-id' } }),
    whoami({ status: 'ready', evidence: ['official_creator_host'] }),
    whoami({ status: 'page_not_ready', identity: null, evidence: ['conflicting_identity'], pageKind: 'login' })
  ])('rejects incomplete, oversized or inconsistent identity output', (value) => {
    expect(() => xiaohongshuManagedBrowserAdapter.parseWhoamiResult(value))
      .toThrowError(AdapterResultValidationError)
  })
})
