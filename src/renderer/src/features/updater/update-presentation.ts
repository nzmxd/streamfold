import type { UpdateState, UpdateUnsupportedReason } from '../../../../shared/contracts'

export type UpdateAction = 'check' | 'download' | 'restart' | null
export type UpdateTone = 'neutral' | 'brand' | 'success' | 'danger'

export interface UpdatePresentation {
  badge: string
  title: string
  description: string
  tone: UpdateTone
  action: UpdateAction
  actionLabel: string
  actionDisabled: boolean
  progressVisible: boolean
  progressPercent: number
  progressDetail: string
  titlebarLabel: string
  titlebarAttention: boolean
}

export function presentUpdate(state: UpdateState): UpdatePresentation {
  const currentVersion = versionLabel(state.currentVersion)
  const availableVersion = versionLabel(state.availableVersion)
  const progressPercent = normalizedProgress(state)
  const progressDetail = formatUpdateProgress(state)

  switch (state.phase) {
    case 'unsupported':
      return presentation({
        badge: '暂不可用',
        title: '此安装版本不支持在线更新',
        description: unsupportedDescription(state.unsupportedReason),
        tone: 'neutral',
        action: null,
        titlebarLabel: '查看软件更新设置'
      })
    case 'idle':
      return presentation({
        badge: '待检查',
        title: `当前版本 ${currentVersion}`,
        description: state.automaticChecks
          ? '应用会定期检查新版本，也可以立即手动检查。'
          : '自动检查已关闭，你仍然可以随时手动检查。',
        tone: 'neutral',
        action: 'check',
        actionLabel: '检查更新',
        titlebarLabel: '检查软件更新'
      })
    case 'checking':
      return presentation({
        badge: '检查中',
        title: '正在检查更新',
        description: '正在连接更新服务器，请稍候。',
        tone: 'brand',
        action: 'check',
        actionLabel: '正在检查…',
        actionDisabled: true,
        titlebarLabel: '正在检查软件更新'
      })
    case 'up-to-date':
      return presentation({
        badge: '已是最新',
        title: `${currentVersion} 已是最新版本`,
        description: '当前无需下载更新。',
        tone: 'success',
        action: 'check',
        actionLabel: '再次检查',
        titlebarLabel: '已是最新版本'
      })
    case 'available':
      return presentation({
        badge: '发现更新',
        title: `${availableVersion} 可以更新`,
        description: '新版本已找到，更新包即将开始下载。',
        tone: 'brand',
        action: 'download',
        actionLabel: '下载更新',
        titlebarLabel: `发现新版本 ${availableVersion}`,
        titlebarAttention: true
      })
    case 'downloading':
      return presentation({
        badge: '下载中',
        title: `正在下载 ${availableVersion}`,
        description: '下载期间可以继续使用应用。',
        tone: 'brand',
        action: 'download',
        actionLabel: '正在下载…',
        actionDisabled: true,
        progressVisible: true,
        progressPercent,
        progressDetail,
        titlebarLabel: `正在下载 ${availableVersion}，${progressPercent}%`
      })
    case 'downloaded':
      return presentation({
        badge: '等待安装',
        title: `${availableVersion} 已准备好`,
        description: '重启应用即可完成安装。',
        tone: 'success',
        action: 'restart',
        actionLabel: '重启并安装',
        progressVisible: true,
        progressPercent: 100,
        progressDetail: progressDetail || '更新包已下载完成',
        titlebarLabel: `${availableVersion} 已准备好，点击查看`,
        titlebarAttention: true
      })
    case 'error': {
      const canRetryDownload = Boolean(state.availableVersion)
      return presentation({
        badge: '需要重试',
        title: canRetryDownload ? `${availableVersion} 下载未完成` : '暂时无法检查更新',
        description: state.error || '更新服务暂不可用，请稍后重试。',
        tone: 'danger',
        action: canRetryDownload ? 'download' : 'check',
        actionLabel: canRetryDownload ? '重新下载' : '重新检查',
        titlebarLabel: '软件更新需要重试'
      })
    }
  }
}

function presentation(value: Partial<UpdatePresentation> & Pick<UpdatePresentation, 'badge' | 'title' | 'description' | 'tone' | 'action' | 'titlebarLabel'>): UpdatePresentation {
  return {
    actionLabel: '',
    actionDisabled: false,
    progressVisible: false,
    progressPercent: 0,
    progressDetail: '',
    titlebarAttention: false,
    ...value
  }
}

function unsupportedDescription(reason: UpdateUnsupportedReason | null): string {
  if (reason === 'development') return '开发环境不会连接正式更新源，请在正式安装版本中检查更新。'
  if (reason === 'missing-source') return '当前版本没有配置可用的更新源。'
  if (reason === 'unsupported-package') return '当前 Linux 安装格式不支持在线更新，请改用 AppImage。'
  return '请使用正式安装包获取后续在线更新。'
}

function versionLabel(value: string | null): string {
  return value ? `v${value.replace(/^v/i, '')}` : '新版本'
}

function normalizedProgress(state: UpdateState): number {
  if (!state.progress) return state.phase === 'downloaded' ? 100 : 0
  return Math.round(Math.min(100, Math.max(0, state.progress.percent)))
}

export function formatUpdateProgress(state: UpdateState): string {
  const progress = state.progress
  if (!progress) return ''
  const transferred = formatBytes(progress.transferred)
  const total = progress.total > 0 ? formatBytes(progress.total) : ''
  const speed = progress.bytesPerSecond > 0 ? `${formatBytes(progress.bytesPerSecond)}/秒` : ''
  const amount = total ? `${transferred} / ${total}` : transferred
  return [amount, speed].filter(Boolean).join(' · ')
}

function formatBytes(value: number): string {
  const safeValue = Number.isFinite(value) && value > 0 ? value : 0
  if (safeValue < 1024) return `${Math.round(safeValue)} B`
  const units = ['KB', 'MB', 'GB']
  let size = safeValue / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024
    unit = units[index]
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`
}
