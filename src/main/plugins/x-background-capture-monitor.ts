import type { WebContents } from 'electron'
import type { PlatformCaptureDeclaration } from '../../shared/plugin-host-contracts'
import {
  BackgroundCaptureSupervisor,
  __backgroundCaptureSupervisorTest,
  type BackgroundCaptureHealth,
  type BackgroundCaptureHealthStatus,
  type BackgroundCaptureNotice,
  type BackgroundCaptureSupervisorOptions
} from './background-capture-supervisor'

type CaptureContents = Pick<WebContents, 'debugger' | 'getURL' | 'isDestroyed' | 'loadURL'>

export interface XBackgroundCaptureNotice {
  captureId: string
  generation: string
  revision: number
}

const SETTINGS_FIELDS = ['/screen_name'] as const
const PROFILE_LEAVES = [
  '__typename',
  'rest_id',
  'core/screen_name',
  'core/name',
  'avatar/image_url',
  'profile_bio/description',
  'legacy/screen_name',
  'legacy/name',
  'legacy/profile_image_url_https',
  'legacy/description',
  'legacy/followers_count',
  'legacy/friends_count',
  'legacy/statuses_count'
] as const
const PROFILE_FIELDS = [
  '/data/user/result',
  '/data/user_result_by_screen_name/result'
].flatMap((base) => [base, `${base}/result`, `${base}/result/result`]
  .flatMap((prefix) => PROFILE_LEAVES.map((leaf) => `${prefix}/${leaf}`)))

/**
 * Source-compatibility facade for pre-1.2 callers. Duplicate responses follow
 * the new supervisor behavior and refresh TTL without emitting another notice.
 */
export class XBackgroundCaptureMonitor {
  private readonly monitor: BackgroundCaptureSupervisor
  private readonly captureIds = new Set<string>()

  constructor(
    contents: CaptureContents,
    onCapture: (notice: XBackgroundCaptureNotice) => void,
    clock: () => number = Date.now
  ) {
    this.monitor = new BackgroundCaptureSupervisor(contents, (notice) => {
      if (notice.reason === 'capture' && notice.captureId) {
        onCapture(legacyNotice(notice))
        return
      }
      if (notice.reason === 'health' && notice.health.status === 'degraded') {
        for (const captureId of this.captureIds) {
          onCapture({ captureId, generation: notice.generation, revision: notice.revision })
        }
      }
    }, clock)
  }

  get generation(): string {
    return this.monitor.generation
  }

  read(
    namespace: string,
    declaration: PlatformCaptureDeclaration,
    expectedUrl: string,
    routeUrl: string,
    limit: number
  ): unknown[] {
    const responseFieldPaths = legacyFields(declaration.id)
    this.captureIds.add(declaration.id)
    return this.monitor.read(
      namespace,
      declaration,
      responseFieldPaths,
      legacyCorrelations(declaration.id),
      legacyRouteParameters(declaration.id, routeUrl),
      expectedUrl,
      routeUrl,
      limit
    )
  }

  dispose(): void {
    this.monitor.dispose()
  }
}

function legacyCorrelations(captureId: string) {
  if (captureId !== 'x.identity.profile.initial') return []
  return [{
    routeParameter: 'handle',
    responseFieldPaths: PROFILE_FIELDS.filter((path) => path.endsWith('/screen_name')),
    comparison: 'case-insensitive' as const
  }]
}

function legacyRouteParameters(captureId: string, routeUrl: string): Record<string, string> {
  if (captureId !== 'x.identity.profile.initial') return {}
  try {
    const handle = decodeURIComponent(new URL(routeUrl).pathname.split('/').filter(Boolean)[0] ?? '')
    return handle ? { handle } : {}
  } catch {
    return {}
  }
}

function legacyFields(captureId: string): readonly string[] {
  if (captureId === 'x.identity.settings') return SETTINGS_FIELDS
  if (captureId === 'x.identity.profile.initial') return PROFILE_FIELDS
  throw new Error('后台监听仅允许官方 X 身份捕获规则')
}

function legacyNotice(notice: BackgroundCaptureNotice): XBackgroundCaptureNotice {
  return {
    captureId: notice.captureId!,
    generation: notice.generation,
    revision: notice.revision
  }
}

export { BackgroundCaptureSupervisor, __backgroundCaptureSupervisorTest }
export type {
  BackgroundCaptureHealth,
  BackgroundCaptureHealthStatus,
  BackgroundCaptureNotice,
  BackgroundCaptureSupervisorOptions
}

export const __xBackgroundCaptureTest = Object.freeze({
  project: (captureId: string, value: unknown) => (
    __backgroundCaptureSupervisorTest.project(value, legacyFields(captureId))
  ),
  matches: __backgroundCaptureSupervisorTest.matches
})
