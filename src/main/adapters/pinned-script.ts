import { createHash, timingSafeEqual } from 'node:crypto'
import type { AdapterOperation, PinnedAdapterScript } from './types'

interface DefinePinnedScriptInput {
  operation: AdapterOperation
  version: string
  expectedSha256: string
  source: string
}

const forbiddenSourcePatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfetch\s*\(/, 'fetch'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bsendBeacon\b/, 'sendBeacon'],
  [/\bdocument\s*\.\s*cookie\b/, 'document.cookie'],
  [/\blocalStorage\b/, 'localStorage'],
  [/\bsessionStorage\b/, 'sessionStorage'],
  [/\bindexedDB\b/, 'indexedDB'],
  [/\bcaches\s*\./, 'CacheStorage'],
  [/\beval\s*\(/, 'eval'],
  [/\bnew\s+Function\b/, 'Function'],
  [/\.\s*(?:click|submit|setAttribute|removeAttribute|appendChild|insertBefore|replaceChild)\s*\(/, 'DOM mutation']
]

/**
 * Creates a script whose reviewed source is cryptographically pinned at build time.
 * A source edit without an explicit hash update fails as soon as the module is loaded.
 */
export function definePinnedScript(input: DefinePinnedScriptInput): PinnedAdapterScript {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.version)) {
    throw new Error('适配器脚本版本无效')
  }
  if (!/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
    throw new Error('适配器脚本固定哈希无效')
  }
  if (!input.source.startsWith('(() => {') || !input.source.trimEnd().endsWith('})()')) {
    throw new Error('适配器脚本必须是立即执行的只读表达式')
  }

  for (const [pattern, capability] of forbiddenSourcePatterns) {
    if (pattern.test(input.source)) throw new Error(`适配器脚本包含禁用能力：${capability}`)
  }

  const actualSha256 = sha256(input.source)
  if (!safeHashEquals(actualSha256, input.expectedSha256)) {
    throw new Error(
      `适配器脚本完整性校验失败（${input.operation}@${input.version}，实际 ${actualSha256}）`
    )
  }

  return Object.freeze({
    metadata: Object.freeze({
      operation: input.operation,
      version: input.version,
      sha256: input.expectedSha256,
      executionWorld: 'isolated' as const,
      permissions: Object.freeze(['location.read', 'visible_dom.read'] as const),
      networkAccess: false as const,
      credentialAccess: false as const,
      mutatesPage: false as const
    }),
    script: input.source
  })
}

export function verifyPinnedScript(script: PinnedAdapterScript): boolean {
  return safeHashEquals(sha256(script.script), script.metadata.sha256)
}

function sha256(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

function safeHashEquals(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(actual, 'ascii'), Buffer.from(expected, 'ascii'))
}
