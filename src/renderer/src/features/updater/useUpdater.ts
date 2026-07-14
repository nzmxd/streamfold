import { readonly, ref, shallowRef } from 'vue'
import type { UpdateApi, UpdateState } from '../../../../shared/contracts'
import { messageOf } from '../shared/format'

const updateState = shallowRef<UpdateState>(emptyUpdateState())
const ready = ref(false)
const bridgeError = ref('')

let initialized = false
let generation = 0
let initializePromise: Promise<void> | null = null
let removeUpdateListener: (() => void) | null = null

function emptyUpdateState(): UpdateState {
  return {
    phase: 'idle',
    currentVersion: '0.0.0',
    availableVersion: null,
    releaseDate: null,
    lastCheckedAt: null,
    progress: null,
    error: '',
    automaticChecks: true,
    unsupportedReason: null
  }
}

function api(): UpdateApi {
  if (typeof window.socialVault?.updates !== 'object') {
    throw new Error('更新服务不可用')
  }
  return window.socialVault.updates
}

function apply(state: UpdateState): void {
  updateState.value = {
    ...state,
    progress: state.progress ? { ...state.progress } : null
  }
  ready.value = true
  bridgeError.value = ''
}

export function initializeUpdater(): Promise<void> {
  if (initialized) return initializePromise ?? Promise.resolve()
  initialized = true
  const currentGeneration = ++generation

  try {
    const updates = api()
    removeUpdateListener = updates.onChanged((state) => {
      if (generation === currentGeneration) apply(state)
    })
    initializePromise = updates.getState()
      .then((state) => {
        if (generation === currentGeneration) apply(state)
      })
      .catch(() => {
        if (generation !== currentGeneration) return
        ready.value = true
        bridgeError.value = '无法读取更新状态，请稍后重试。'
      })
      .finally(() => {
        if (generation === currentGeneration) initializePromise = null
      })
  } catch {
    ready.value = true
    bridgeError.value = '当前无法使用在线更新。'
    initializePromise = Promise.resolve()
  }

  return initializePromise
}

export function disposeUpdater(): void {
  generation += 1
  removeUpdateListener?.()
  removeUpdateListener = null
  initializePromise = null
  initialized = false
  ready.value = false
  bridgeError.value = ''
  updateState.value = emptyUpdateState()
}

async function checkForUpdates(): Promise<UpdateState> {
  return runStateAction('check', '无法检查更新，请稍后重试。')
}

async function downloadUpdate(): Promise<UpdateState> {
  return runStateAction('download', '无法下载更新，请稍后重试。')
}

async function runStateAction(
  action: 'check' | 'download',
  failureMessage: string
): Promise<UpdateState> {
  bridgeError.value = ''
  try {
    const state = await api()[action]()
    apply(state)
    return state
  } catch (cause) {
    bridgeError.value = actionError(cause, failureMessage)
    throw cause
  }
}

async function restartAndInstall(): Promise<void> {
  bridgeError.value = ''
  try {
    await api().restartAndInstall()
  } catch (cause) {
    bridgeError.value = actionError(cause, '无法启动更新安装，请稍后重试。')
    throw cause
  }
}

function actionError(cause: unknown, fallback: string): string {
  const message = messageOf(cause).trim()
  return message && message !== '[object Object]' ? message : fallback
}

export function useUpdater() {
  return {
    state: readonly(updateState),
    ready: readonly(ready),
    bridgeError: readonly(bridgeError),
    check: checkForUpdates,
    download: downloadUpdate,
    restartAndInstall
  }
}
