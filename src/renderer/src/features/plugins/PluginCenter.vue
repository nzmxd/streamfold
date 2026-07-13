<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { PluginCapability, PluginInstallation } from '../../../../shared/contracts'
import { formatDate, messageOf } from '../shared/format'

const plugins = ref<PluginInstallation[]>([])
const loading = ref(true)
const error = ref('')
const busyPluginId = ref<string | null>(null)

const capabilityLabels: Partial<Record<PluginCapability, string>> = {
  'account.identity': '核验当前登录身份',
  'account.profile': '读取本人账号资料',
  'account.metrics': '读取本人账号指标',
  'content.list': '读取本人内容列表',
  'content.metrics': '读取本人内容指标'
}

function capabilityLabel(capability: PluginCapability): string {
  return capabilityLabels[capability] ?? capability
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    plugins.value = await window.socialVault.plugins.list()
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    loading.value = false
  }
}

async function togglePlugin(plugin: PluginInstallation): Promise<void> {
  if (plugin.availability !== 'available' || busyPluginId.value) return
  busyPluginId.value = plugin.manifest.id
  error.value = ''
  try {
    const updated = await window.socialVault.plugins.setEnabled(plugin.manifest.id, !plugin.enabled)
    const index = plugins.value.findIndex((item) => item.manifest.id === updated.manifest.id)
    if (index >= 0) plugins.value.splice(index, 1, updated)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    busyPluginId.value = null
  }
}

onMounted(() => void load())
</script>

<template>
  <div class="feature-page plugin-page">
    <header class="page-header feature-header">
      <div>
        <span class="page-eyebrow">平台连接能力</span>
        <h1>插件中心</h1>
        <p>启用和管理各平台的数据同步</p>
      </div>
    </header>

    <div v-if="error" class="alert error">
      <span>{{ error }}</span>
      <button @click="error = ''">关闭</button>
    </div>
    <div v-if="loading" class="feature-loading">正在加载插件…</div>

    <section v-else class="plugin-grid">
      <article
        v-for="plugin in plugins"
        :key="plugin.manifest.id"
        class="plugin-card"
        :class="{ planned: plugin.availability === 'planned' }"
      >
        <header>
          <span class="plugin-mark">◇</span>
          <div>
            <div class="title-line">
              <h2>{{ plugin.manifest.name }}</h2>
              <span>v{{ plugin.manifest.version }}</span>
            </div>
            <p>{{ plugin.manifest.description }}</p>
          </div>
          <button
            class="switch-control"
            role="switch"
            :aria-checked="plugin.enabled"
            :aria-label="`${plugin.enabled ? '停用' : '启用'} ${plugin.manifest.name}`"
            :disabled="plugin.availability !== 'available' || busyPluginId !== null"
            :class="{ active: plugin.enabled }"
            @click="togglePlugin(plugin)"
          ><i></i></button>
        </header>

        <div class="plugin-badges">
          <span>{{ plugin.enabled ? '已启用' : '未启用' }}</span>
          <span v-if="plugin.availability === 'planned'" class="planned-badge">规划中</span>
        </div>

        <dl class="manifest-list">
          <div>
            <dt>权限</dt>
            <dd>
              <span v-for="capability in plugin.manifest.capabilities" :key="capability">
                {{ capabilityLabel(capability) }}
              </span>
            </dd>
          </div>
          <div>
            <dt>运行记录</dt>
            <dd>成功 {{ plugin.successCount }} 次 · 失败 {{ plugin.failureCount }} 次 · 最近 {{ formatDate(plugin.lastRunAt, true) }}</dd>
          </div>
        </dl>

        <footer>
          <span v-if="plugin.lastError" class="plugin-error">最近错误：{{ plugin.lastError }}</span>
          <span v-else>{{ plugin.availability === 'planned' ? '该平台接口正在开发中' : plugin.enabled ? '可以在账号中心使用' : '启用后可在账号中心使用' }}</span>
        </footer>
      </article>
    </section>
  </div>
</template>
