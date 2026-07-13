import { definePinnedScript } from './pinned-script'
import type { ManagedBrowserAdapter } from './types'
import { parseProbeResult, parseWhoamiResult } from './validation'

export const XIAOHONGSHU_ADAPTER_ID = 'xiaohongshu-managed-browser'
export const XIAOHONGSHU_ADAPTER_VERSION = '0.1.0'
export const XIAOHONGSHU_CREATOR_HOST = 'creator.xiaohongshu.com'
export const XIAOHONGSHU_PROBE_SCRIPT_VERSION = 'xhs-creator-probe-dom-v1'
export const XIAOHONGSHU_WHOAMI_SCRIPT_VERSION = 'xhs-creator-whoami-dom-v1'

const probeScriptSource = String.raw`(() => {
  'use strict'
  const adapterId = 'xiaohongshu-managed-browser'
  const adapterVersion = '0.1.0'
  const scriptVersion = 'xhs-creator-probe-dom-v1'
  const officialHost = 'creator.xiaohongshu.com'
  const current = new URL(location.href)
  const host = current.hostname.toLowerCase().replace(/\.$/, '')
  const pageUrl = current.origin + current.pathname
  const evidence = []
  const add = (code) => { if (!evidence.includes(code)) evidence.push(code) }
  const isVisible = (element) => {
    if (!(element instanceof Element) || element.getAttribute('aria-hidden') === 'true') return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const visibleElements = (selector) => {
    try { return Array.from(document.querySelectorAll(selector)).filter(isVisible) } catch { return [] }
  }
  const visibleTextMatches = (selector, pattern) => visibleElements(selector).some((element) => {
    const text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
    return text.length <= 80 && pattern.test(text)
  })

  if (host !== officialHost || current.protocol !== 'https:') {
    return {
      schemaVersion: 1, operation: 'probe', adapterId, adapterVersion, scriptVersion,
      pageUrl, pageKind: 'unsupported', supported: false,
      status: 'unsupported', evidence
    }
  }

  add('official_creator_host')
  if (document.readyState === 'loading') add('document_loading')
  else add('dom_ready')

  const route = current.pathname.toLowerCase()
  const loginRoute = /(?:^|\/)(?:login|signin)(?:\/|$)/.test(route)
  const challengeRoute = /(?:^|\/)(?:captcha|challenge|verify|security)(?:\/|$)/.test(route)
  const visibleLogin = visibleTextMatches('button, a, [role="button"]', /^(?:登录|扫码登录|手机号登录|立即登录)$/)
  const visibleChallenge = visibleElements('[class*="captcha"], [class*="challenge"], iframe[src*="captcha"], iframe[src*="verify"]').length > 0
  const visibleProfile = visibleElements('header a[href*="/user/profile/"], nav a[href*="/user/profile/"], [class*="header"] a[href*="/user/profile/"], [class*="user"] a[href*="/user/profile/"]').length > 0
  const visibleAccount = visibleElements('header [class*="avatar"], header [class*="user"], nav [class*="avatar"], [class*="header"] [class*="avatar"]').length > 0
  if (loginRoute) add('login_route')
  if (challengeRoute) add('challenge_route')
  if (visibleLogin) add('visible_login_control')
  if (visibleChallenge) add('visible_challenge')
  if (visibleAccount) add('visible_account_control')
  if (visibleProfile) add('visible_profile_link')

  let status = 'page_not_ready'
  let pageKind = 'creator'
  if (challengeRoute || visibleChallenge) status = 'challenge'
  else if (loginRoute || visibleLogin) { status = 'login_required'; pageKind = 'login' }
  else if (document.readyState !== 'loading' && (visibleProfile || visibleAccount)) status = 'ready'

  return {
    schemaVersion: 1, operation: 'probe', adapterId, adapterVersion, scriptVersion,
    pageUrl, pageKind, supported: true, status, evidence
  }
})()`

const whoamiScriptSource = String.raw`(() => {
  'use strict'
  const adapterId = 'xiaohongshu-managed-browser'
  const adapterVersion = '0.1.0'
  const scriptVersion = 'xhs-creator-whoami-dom-v1'
  const officialHost = 'creator.xiaohongshu.com'
  const current = new URL(location.href)
  const host = current.hostname.toLowerCase().replace(/\.$/, '')
  const pageUrl = current.origin + current.pathname
  const evidence = []
  const add = (code) => { if (!evidence.includes(code)) evidence.push(code) }
  const cleanName = (value) => {
    const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!text || text.length > 80 || /^(?:我|我的|个人中心|个人主页|账号|头像|创作中心)$/.test(text)) return null
    return text
  }
  const cleanId = (value) => {
    const text = String(value || '').trim()
    return /^[a-zA-Z0-9_-]{3,80}$/.test(text) ? text : null
  }
  const isVisible = (element) => {
    if (!(element instanceof Element) || element.getAttribute('aria-hidden') === 'true') return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const visibleElements = (selector) => {
    try { return Array.from(document.querySelectorAll(selector)).filter(isVisible) } catch { return [] }
  }
  const visibleTextMatches = (selector, pattern) => visibleElements(selector).some((element) => {
    const text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
    return text.length <= 80 && pattern.test(text)
  })
  const nameOf = (element) => cleanName(
    element.getAttribute('data-user-name') || element.getAttribute('title') ||
    element.getAttribute('aria-label') || element.innerText || element.textContent
  )

  if (host !== officialHost || current.protocol !== 'https:') {
    return {
      schemaVersion: 1, operation: 'whoami', adapterId, adapterVersion, scriptVersion,
      pageUrl, pageKind: 'unsupported', status: 'unsupported',
      identity: null, evidence
    }
  }

  add('official_creator_host')
  const route = current.pathname.toLowerCase()
  const loginRoute = /(?:^|\/)(?:login|signin)(?:\/|$)/.test(route)
  const challengeRoute = /(?:^|\/)(?:captcha|challenge|verify|security)(?:\/|$)/.test(route)
  const visibleLogin = visibleTextMatches('button, a, [role="button"]', /^(?:登录|扫码登录|手机号登录|立即登录)$/)
  const visibleChallenge = visibleElements('[class*="captcha"], [class*="challenge"], iframe[src*="captcha"], iframe[src*="verify"]').length > 0
  if (document.readyState === 'loading') add('document_loading')
  if (loginRoute) add('login_route')
  if (challengeRoute) add('challenge_route')
  if (visibleLogin) add('visible_login_control')
  if (visibleChallenge) add('visible_challenge')

  if (challengeRoute || visibleChallenge) {
    return {
      schemaVersion: 1, operation: 'whoami', adapterId, adapterVersion, scriptVersion,
      pageUrl, pageKind: 'creator', status: 'challenge', identity: null, evidence
    }
  }
  if (loginRoute || visibleLogin) {
    return {
      schemaVersion: 1, operation: 'whoami', adapterId, adapterVersion, scriptVersion,
      pageUrl, pageKind: 'login', status: 'login_required', identity: null, evidence
    }
  }
  if (document.readyState === 'loading') {
    return {
      schemaVersion: 1, operation: 'whoami', adapterId, adapterVersion, scriptVersion,
      pageUrl, pageKind: 'creator', status: 'page_not_ready', identity: null, evidence
    }
  }

  const profileLinks = visibleElements('header a[href*="/user/profile/"], nav a[href*="/user/profile/"]')
  const visibleUserElements = visibleElements('header [data-user-id], nav [data-user-id]')
  const linkCandidates = []
  const dataCandidates = []
  for (const link of profileLinks) {
    try {
      const target = new URL(link.getAttribute('href') || '', current.origin)
      const match = target.pathname.match(/\/user\/profile\/([a-zA-Z0-9_-]{3,80})(?:\/|$)/)
      const remoteId = cleanId(match && match[1])
      const remoteName = nameOf(link)
      if (remoteId) linkCandidates.push({ remoteId, remoteName })
    } catch {}
  }
  for (const element of visibleUserElements) {
    const remoteId = cleanId(element.getAttribute('data-user-id'))
    const remoteName = nameOf(element)
    if (remoteId) dataCandidates.push({ remoteId, remoteName })
  }
  if (profileLinks.length > 0) add('visible_profile_link')
  if (visibleUserElements.length > 0) add('visible_user_id')

  const candidates = [...linkCandidates, ...dataCandidates]
  const ids = Array.from(new Set(candidates.map((item) => item.remoteId)))
  if (ids.length > 1) add('conflicting_identity')
  const selectedId = ids.length === 1 &&
    linkCandidates.some((item) => item.remoteId === ids[0]) &&
    dataCandidates.some((item) => item.remoteId === ids[0])
      ? ids[0]
      : null
  const selected = selectedId
    ? candidates.find((item) => item.remoteId === selectedId && item.remoteName)
    : null
  if (selected) {
    return {
      schemaVersion: 1, operation: 'whoami', adapterId, adapterVersion, scriptVersion,
      pageUrl, pageKind: 'creator', status: 'ready',
      identity: { remoteId: selected.remoteId, remoteName: selected.remoteName, profileUrl: null },
      evidence
    }
  }

  return {
    schemaVersion: 1, operation: 'whoami', adapterId, adapterVersion, scriptVersion,
    pageUrl, pageKind: 'creator', status: 'page_not_ready', identity: null, evidence
  }
})()`

const probeScript = definePinnedScript({
  operation: 'probe',
  version: XIAOHONGSHU_PROBE_SCRIPT_VERSION,
  expectedSha256: 'a34b5b1a6f0f5f4f009f2b22a36502e7a74dad0a5bbbd2191b8f5a26f0d9fcd7',
  source: probeScriptSource
})

const whoamiScript = definePinnedScript({
  operation: 'whoami',
  version: XIAOHONGSHU_WHOAMI_SCRIPT_VERSION,
  expectedSha256: 'e878b39918e886cc8f1824fc0f151996dfa394f6a9d53b37542aa16d38aecab3',
  source: whoamiScriptSource
})

const metadata = Object.freeze({
  schemaVersion: 1 as const,
  id: XIAOHONGSHU_ADAPTER_ID,
  version: XIAOHONGSHU_ADAPTER_VERSION,
  platformId: 'xiaohongshu' as const,
  allowedHosts: Object.freeze([XIAOHONGSHU_CREATOR_HOST]),
  readOnly: true as const,
  capabilities: Object.freeze(['probe', 'whoami'] as const)
})

export const xiaohongshuManagedBrowserAdapter: ManagedBrowserAdapter = Object.freeze({
  metadata,
  scripts: Object.freeze({ probe: probeScript, whoami: whoamiScript }),
  parseProbeResult(value: unknown) {
    return parseProbeResult(value, {
      adapterId: metadata.id,
      adapterVersion: metadata.version,
      scriptVersion: probeScript.metadata.version,
      allowedHosts: metadata.allowedHosts
    })
  },
  parseWhoamiResult(value: unknown) {
    return parseWhoamiResult(value, {
      adapterId: metadata.id,
      adapterVersion: metadata.version,
      scriptVersion: whoamiScript.metadata.version,
      allowedHosts: metadata.allowedHosts
    })
  }
})
