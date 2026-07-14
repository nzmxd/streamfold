<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatDate } from '../shared/format'
import { presentUpdate } from '../updater/update-presentation'
import { useUpdater } from '../updater/useUpdater'

const props = defineProps<{ autoCheckUpdates: boolean }>()
const emit = defineEmits<{ 'update:autoCheckUpdates': [value: boolean] }>()

const updater = useUpdater()
const actionBusy = ref(false)
const preferenceBusy = ref(false)
const localError = ref('')
const presentation = computed(() => presentUpdate(updater.state.value))
const hasBridgeError = computed(() => Boolean(updater.bridgeError.value))
const cardTone = computed(() => hasBridgeError.value ? 'danger' : presentation.value.tone)
const statusBadge = computed(() => {
  if (!updater.ready.value) return '读取中'
  return hasBridgeError.value ? '需要重试' : presentation.value.badge
})
const statusTitle = computed(() => {
  if (!updater.ready.value) return '正在读取更新状态'
  return hasBridgeError.value ? '暂时无法连接更新服务' : presentation.value.title
})
const statusDescription = computed(() => {
  if (!updater.ready.value) return '正在确认当前版本和更新状态。'
  return updater.bridgeError.value || presentation.value.description
})
const actionLabel = computed(() => {
  if (!updater.ready.value) return '正在读取…'
  if (actionBusy.value) return presentation.value.action === 'restart' ? '正在重启…' : '处理中…'
  return presentation.value.actionLabel
})
const actionDisabled = computed(() => (
  !updater.ready.value || actionBusy.value || presentation.value.actionDisabled
))
const checkedAt = computed(() => formatDate(updater.state.value.lastCheckedAt, true))
const releaseDate = computed(() => formatDate(updater.state.value.releaseDate))

async function runPrimaryAction(): Promise<void> {
  const action = presentation.value.action
  if (!action || actionDisabled.value) return
  actionBusy.value = true
  localError.value = ''
  try {
    if (action === 'check') await updater.check()
    else if (action === 'download') await updater.download()
    else await updater.restartAndInstall()
  } catch {
    localError.value = updater.bridgeError.value || '更新操作未能完成，请稍后重试。'
  } finally {
    actionBusy.value = false
  }
}

async function toggleAutomaticChecks(): Promise<void> {
  if (preferenceBusy.value) return
  preferenceBusy.value = true
  localError.value = ''
  try {
    const result = await window.socialVault.settings.update({
      autoCheckUpdates: !props.autoCheckUpdates
    })
    emit('update:autoCheckUpdates', result.autoCheckUpdates)
  } catch {
    localError.value = '无法保存自动检查设置，请稍后重试。'
  } finally {
    preferenceBusy.value = false
  }
}
</script>

<template>
  <section id="software-update" class="feature-card update-card" :class="`tone-${cardTone}`" aria-labelledby="software-update-title">
    <header class="update-card-head">
      <span class="update-card-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12 3v11" /><path d="m7.5 10 4.5 4.5 4.5-4.5" /><path d="M5 18.5h14" /></svg>
      </span>
      <div>
        <h2 id="software-update-title">软件更新</h2>
        <p>获取归页的功能改进与问题修复</p>
      </div>
      <span class="update-status-badge">{{ statusBadge }}</span>
    </header>

    <div class="update-card-body">
      <div class="update-status-copy" aria-live="polite" aria-atomic="true">
        <strong>{{ statusTitle }}</strong>
        <p>{{ statusDescription }}</p>
        <div v-if="updater.state.value.lastCheckedAt || updater.state.value.releaseDate" class="update-metadata">
          <span v-if="updater.state.value.lastCheckedAt">最近检查 {{ checkedAt }}</span>
          <span v-if="updater.state.value.releaseDate">版本发布 {{ releaseDate }}</span>
        </div>
      </div>
      <div v-if="presentation.action" class="update-actions">
        <button
          class="button"
          :class="{ primary: presentation.action === 'restart' || presentation.action === 'download' }"
          type="button"
          :disabled="actionDisabled"
          @click="runPrimaryAction"
        >
          {{ actionLabel }}
        </button>
      </div>
    </div>

    <div v-if="presentation.progressVisible" class="update-progress-group">
      <div><span>下载进度</span><strong>{{ presentation.progressPercent }}%</strong></div>
      <progress :value="presentation.progressPercent" max="100" :aria-label="`更新下载进度 ${presentation.progressPercent}%`" />
      <small>{{ presentation.progressDetail }}</small>
    </div>

    <div v-if="localError" class="update-inline-error" role="alert">
      <span>{{ localError }}</span>
      <button type="button" aria-label="关闭更新错误提示" @click="localError = ''">关闭</button>
    </div>

    <footer class="update-preference">
      <div>
        <strong>自动检查更新</strong>
        <small>应用启动后定期检查，新版本下载完成后由你决定何时安装。</small>
      </div>
      <button
        class="switch-control update-switch"
        :class="{ active: autoCheckUpdates }"
        type="button"
        role="switch"
        :aria-checked="autoCheckUpdates"
        aria-label="自动检查软件更新"
        :disabled="preferenceBusy"
        @click="toggleAutomaticChecks"
      ><i /></button>
    </footer>
  </section>
</template>
