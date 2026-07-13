import type {
  AdapterExecutionStatus,
  AdapterIdentity,
  AdapterPageKind,
  AdapterProbeResult,
  AdapterWhoamiResult,
  ProbeEvidenceCode,
  WhoamiEvidenceCode
} from './types'
import {
  adapterExecutionStatuses,
  adapterPageKinds,
  probeEvidenceCodes,
  whoamiEvidenceCodes
} from './types'

export interface AdapterResultExpectation {
  adapterId: string
  adapterVersion: string
  scriptVersion: string
  allowedHosts: readonly string[]
}

export class AdapterResultValidationError extends Error {
  readonly code = 'INVALID_ADAPTER_RESULT'

  constructor() {
    super('平台页面返回了无效的适配器结果')
    this.name = 'AdapterResultValidationError'
  }
}

export function parseProbeResult(
  value: unknown,
  expectation: AdapterResultExpectation
): AdapterProbeResult {
  const record = exactRecord(value, [
    'schemaVersion', 'operation', 'adapterId', 'adapterVersion', 'scriptVersion',
    'pageUrl', 'pageKind', 'supported', 'status', 'evidence'
  ])
  validateHeader(record, expectation, 'probe')
  const pageUrl = parseOfficialPageUrl(record.pageUrl, expectation.allowedHosts)
  const pageKind = enumValue(record.pageKind, adapterPageKinds)
  const supported = booleanValue(record.supported)
  const status = enumValue(record.status, adapterExecutionStatuses)
  const evidence = evidenceValues(record.evidence, probeEvidenceCodes)

  validateCommonSemantics(pageKind, status, evidence)
  if (supported !== (status !== 'unsupported')) invalid()
  if (status === 'ready' && !hasAny(evidence, ['visible_account_control', 'visible_profile_link'])) invalid()

  return freezeResult({
    schemaVersion: 1,
    operation: 'probe',
    adapterId: expectation.adapterId,
    adapterVersion: expectation.adapterVersion,
    scriptVersion: expectation.scriptVersion,
    pageUrl,
    pageKind,
    supported,
    status,
    evidence: evidence as ProbeEvidenceCode[]
  })
}

export function parseWhoamiResult(
  value: unknown,
  expectation: AdapterResultExpectation
): AdapterWhoamiResult {
  const record = exactRecord(value, [
    'schemaVersion', 'operation', 'adapterId', 'adapterVersion', 'scriptVersion',
    'pageUrl', 'pageKind', 'status', 'identity', 'evidence'
  ])
  validateHeader(record, expectation, 'whoami')
  const pageUrl = parseOfficialPageUrl(record.pageUrl, expectation.allowedHosts)
  const pageKind = enumValue(record.pageKind, adapterPageKinds)
  const status = enumValue(record.status, adapterExecutionStatuses)
  const identity = record.identity === null ? null : parseIdentity(record.identity, expectation.allowedHosts)
  const evidence = evidenceValues(record.evidence, whoamiEvidenceCodes)

  validateCommonSemantics(pageKind, status, evidence)
  if ((status === 'ready') !== (identity !== null)) invalid()
  if (status === 'ready' && !['visible_profile_link', 'visible_user_id'].every((item) => evidence.includes(item as WhoamiEvidenceCode))) invalid()
  if (evidence.includes('conflicting_identity') && status !== 'page_not_ready') invalid()

  return freezeResult({
    schemaVersion: 1,
    operation: 'whoami',
    adapterId: expectation.adapterId,
    adapterVersion: expectation.adapterVersion,
    scriptVersion: expectation.scriptVersion,
    pageUrl,
    pageKind,
    status,
    identity,
    evidence: evidence as WhoamiEvidenceCode[]
  })
}

function validateHeader(
  record: Record<string, unknown>,
  expectation: AdapterResultExpectation,
  operation: 'probe' | 'whoami'
): void {
  expectExact(record.schemaVersion, 1)
  expectExact(record.operation, operation)
  expectExact(record.adapterId, expectation.adapterId)
  expectExact(record.adapterVersion, expectation.adapterVersion)
  expectExact(record.scriptVersion, expectation.scriptVersion)
}

function validateCommonSemantics(
  pageKind: AdapterPageKind,
  status: AdapterExecutionStatus,
  evidence: readonly string[]
): void {
  if ((pageKind === 'unsupported') !== (status === 'unsupported')) invalid()
  if (status === 'login_required' && !hasAny(evidence, ['login_route', 'visible_login_control'])) invalid()
  if (status === 'challenge' && !hasAny(evidence, ['challenge_route', 'visible_challenge'])) invalid()
  if (status === 'page_not_ready' && pageKind !== 'creator') invalid()
}

function parseIdentity(value: unknown, allowedHosts: readonly string[]): AdapterIdentity {
  const record = exactRecord(value, ['remoteId', 'remoteName', 'profileUrl'])
  const remoteId = boundedText(record.remoteId, 3, 80, /^[a-zA-Z0-9_-]+$/)
  const remoteName = boundedText(record.remoteName, 1, 80, /^[^\u0000-\u001f\u007f]+$/u)
  const profileUrl = record.profileUrl === null
    ? null
    : parseOfficialPageUrl(record.profileUrl, allowedHosts, remoteId)
  return Object.freeze({ remoteId, remoteName, profileUrl })
}

function parseOfficialPageUrl(value: unknown, allowedHosts: readonly string[], remoteId?: string): string {
  const text = boundedText(value, 1, 2048)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return invalid()
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (
    url.protocol !== 'https:' || url.username || url.password ||
    (url.port && url.port !== '443') || !allowedHosts.includes(hostname) ||
    url.search || url.hash
  ) invalid()
  if (remoteId && !url.pathname.split('/').includes(remoteId)) invalid()
  return url.toString()
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const record = value as Record<string, unknown>
  const prototype = Object.getPrototypeOf(record)
  if (prototype !== Object.prototype && prototype !== null) return invalid()
  const actualKeys = Object.keys(record)
  if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key))) invalid()
  for (const key of actualKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) invalid()
  }
  return record
}

function expectExact(value: unknown, expected: string | number): void {
  if (value !== expected) invalid()
}

function boundedText(value: unknown, min: number, max: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) return invalid()
  if (value !== value.trim() || pattern && !pattern.test(value)) return invalid()
  return value
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid()
  return value
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) return invalid()
  return value as T[number]
}

function evidenceValues<const T extends readonly string[]>(value: unknown, values: T): T[number][] {
  if (!Array.isArray(value) || value.length > values.length) return invalid()
  const parsed = value.map((item) => enumValue(item, values))
  if (new Set(parsed).size !== parsed.length) return invalid()
  return parsed
}

function hasAny<T>(values: readonly T[], expected: readonly T[]): boolean {
  return expected.some((item) => values.includes(item))
}

function freezeResult<T extends { evidence: string[] }>(result: T): T {
  Object.freeze(result.evidence)
  return Object.freeze(result)
}

function invalid(): never {
  throw new AdapterResultValidationError()
}
