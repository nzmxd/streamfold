<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type {
  Account,
  ContentDetail,
  ContentFilterView,
  ContentMetricDefinition,
  ContentSnapshot,
  ContentSummary,
  ContentTagFacet,
  ContentType,
  ExportDataResult,
  Group,
  PlatformDefinition
} from '../../../../shared/contracts'
import { confirmDialog } from '../../ui/dialog'
import { accountDisplayName } from '../accounts/presentation'
import { contentTypeLabel, formatDate, formatNumber, messageOf } from '../shared/format'
import {
  persistContentSortPreference,
  readContentSortPreference
} from './content-preferences'
import {
  availableContentMetricDefinitions,
  contentMetricDelta,
  contentMetricValue,
  formatContentMetric,
  formatContentMetricDelta,
  primaryContentMetric,
  resolveContentMetricDefinitions,
  type ContentMetricId
} from './metrics'
import {
  contentFilterViewStateFromFilters,
  contentSearchQueryFromFilters,
  contentSearchFiltersFromViewState,
  contentTagFacetQueryFromFilters,
  createDefaultContentSearchFilters,
  paginationRange,
  reconcileContentFilterViewStateReferences,
  reconcileContentSelection,
  reconcilePageSelection,
  selectedContentOriginalUrls,
  tagsFromInput,
  tagsToInput,
  toggleSelectedTag,
  type ContentSearchFilters
} from './query'

const platforms = ref<PlatformDefinition[]>([])
const accounts = ref<Account[]>([])
const groups = ref<Group[]>([])
const filterReferencesLoaded = ref(false)
const filterViews = ref<ContentFilterView[]>([])
const tagFacets = ref<ContentTagFacet[]>([])
const items = ref<ContentSummary[]>([])
const total = ref(0)
const pageOffset = ref(0)
const pageLimit = ref(50)
const hasMore = ref(false)
const selectedId = ref<string | null>(null)
const selectedContentIds = ref<string[]>([])
const detail = ref<ContentDetail | null>(null)
const loading = ref(true)
const detailLoading = ref(false)
const saving = ref(false)
const batchSaving = ref(false)
const batchCopying = ref(false)
const exportBusy = ref(false)
const openingOriginalId = ref<string | null>(null)
const copyingOriginalId = ref<string | null>(null)
const error = ref('')
const notice = ref('')
const advancedFiltersOpen = ref(false)
const filterTagsInput = ref('')
const batchTagsInput = ref('')
const selectedFilterViewId = ref('')
const filterViewBusy = ref(false)
const filterViewDialogOpen = ref(false)
const filterViewName = ref('')
const filterViewDialogError = ref('')
const filterViewDialog = ref<HTMLElement | null>(null)
const filterViewNameInput = ref<HTMLInputElement | null>(null)
const exportFormat = ref<'json' | 'csv'>('csv')
const exportSnapshots = ref(false)
const filters = reactive<ContentSearchFilters>(createDefaultContentSearchFilters())
Object.assign(filters, readContentSortPreference(''))
const edit = reactive({ note: '', tags: '' })
const selectedHistoryMetricId = ref<ContentMetricId | null>(null)
let loadSequence = 0
let detailSequence = 0
let tagSequence = 0
let saveSequence = 0
let removeContentListener: (() => void) | null = null
let filterViewPreviouslyFocused: HTMLElement | null = null

const contentTypeOptions: Array<{ value: ContentType; label: string }> = [
  { value: 'article', label: '文章' },
  { value: 'post', label: '动态' },
  { value: 'image', label: '图文' },
  { value: 'video', label: '视频' },
  { value: 'answer', label: '回答' }
]

const platformMap = computed(() => new Map(platforms.value.map((platform) => [platform.id, platform])))
const selectedFilterView = computed(() => filterViews.value.find((view) => (
  view.id === selectedFilterViewId.value
)) ?? null)
const selectedSummary = computed(() => items.value.find((item) => item.id === selectedId.value) ?? null)
const metricDefinitions = computed(() => resolveContentMetricDefinitions(detail.value?.metricDefinitions ?? []))
const historyMetricDefinitions = computed(() => availableContentMetricDefinitions(
  detail.value?.metricDefinitions ?? [],
  detail.value?.snapshots ?? []
))
const historyMetricDefinition = computed(() => historyMetricDefinitions.value.find((definition) => (
  definition.id === selectedHistoryMetricId.value
)) ?? null)
const pagination = computed(() => paginationRange(total.value, pageOffset.value, pageLimit.value))
const allPageSelected = computed(() => (
  items.value.length > 0 && items.value.every((item) => selectedContentIds.value.includes(item.id))
))
const activeFilterCount = computed(() => [
  filters.keyword.trim(),
  filters.accountId,
  filters.platformId,
  filters.groupId,
  filters.type,
  tagsFromInput(filterTagsInput.value).length > 0 ? 'tags' : '',
  filters.bookmark === 'all' ? '' : filters.bookmark,
  filters.syncWarningOnly ? 'sync-warning' : '',
  filters.publishedFrom,
  filters.publishedTo,
  filters.capturedFrom,
  filters.capturedTo
].filter(Boolean).length)

function platformName(platformId: string): string {
  return platformMap.value.get(platformId)?.name ?? platformId
}

function replaceFilterView(value: ContentFilterView): void {
  filterViews.value = [
    value,
    ...filterViews.value.filter((view) => view.id !== value.id)
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function filterViewReferences(): {
  accountIds: string[]
  platformIds: PlatformDefinition['id'][]
  groupIds: string[]
} {
  return {
    accountIds: accounts.value.map((account) => account.id),
    platformIds: platforms.value.map((platform) => platform.id),
    groupIds: groups.value.map((group) => group.id)
  }
}

async function loadItems(offset = pageOffset.value): Promise<void> {
  const sequence = ++loadSequence
  loading.value = true
  error.value = ''
  try {
    const result = await window.socialVault.content.search(contentSearchQueryFromFilters(filters, offset))
    if (sequence !== loadSequence) return
    if (result.items.length === 0 && result.total > 0 && result.offset > 0) {
      const lastOffset = Math.floor((result.total - 1) / result.limit) * result.limit
      await loadItems(lastOffset)
      return
    }
    items.value = result.items
    total.value = result.total
    pageOffset.value = result.offset
    pageLimit.value = result.limit
    hasMore.value = result.hasMore
    selectedContentIds.value = reconcilePageSelection(result.items, selectedContentIds.value)
    selectedId.value = reconcileContentSelection(result.items, selectedId.value)
  } catch (cause) {
    if (sequence === loadSequence) error.value = messageOf(cause)
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function loadTagFacets(): Promise<void> {
  const sequence = ++tagSequence
  try {
    const result = await window.socialVault.content.listTags(contentTagFacetQueryFromFilters(filters))
    if (sequence === tagSequence) tagFacets.value = result
  } catch (cause) {
    if (sequence === tagSequence) error.value = messageOf(cause)
  }
}

async function loadFilterViews(): Promise<void> {
  try {
    filterViews.value = await window.socialVault.content.listFilterViews()
    if (selectedFilterViewId.value && !selectedFilterView.value) selectedFilterViewId.value = ''
  } catch (cause) {
    error.value = `无法读取筛选视图：${messageOf(cause)}`
  }
}

async function loadDetail(id: string | null): Promise<void> {
  const sequence = ++detailSequence
  detail.value = null
  detailLoading.value = Boolean(id)
  if (!id) return
  try {
    const result = await window.socialVault.content.detail(id)
    if (sequence !== detailSequence || selectedId.value !== id) return
    detail.value = result
    edit.note = result.note
    edit.tags = tagsToInput(result.tags)
  } catch (cause) {
    if (sequence === detailSequence && selectedId.value === id) error.value = messageOf(cause)
  } finally {
    if (sequence === detailSequence && selectedId.value === id) detailLoading.value = false
  }
}

async function applyFilters(): Promise<void> {
  filters.tags = tagsFromInput(filterTagsInput.value)
  filterTagsInput.value = tagsToInput(filters.tags)
  advancedFiltersOpen.value = false
  pageOffset.value = 0
  selectedContentIds.value = []
  notice.value = ''
  await Promise.all([loadItems(0), loadTagFacets()])
}

async function applySelectedFilterView(): Promise<void> {
  if (!selectedFilterViewId.value || filterViewBusy.value) return
  const view = selectedFilterView.value
  if (!view) {
    selectedFilterViewId.value = ''
    error.value = '这个筛选视图已不存在，请重新选择。'
    return
  }
  filterViewBusy.value = true
  error.value = ''
  notice.value = ''
  try {
    const reconciledState = filterReferencesLoaded.value
      ? reconcileContentFilterViewStateReferences(view.state, filterViewReferences())
      : contentFilterViewStateFromFilters(contentSearchFiltersFromViewState(view.state))
    Object.assign(filters, contentSearchFiltersFromViewState(reconciledState))
    filterTagsInput.value = tagsToInput(filters.tags)
    if (filterReferencesLoaded.value && JSON.stringify(reconciledState) !== JSON.stringify(view.state)) {
      replaceFilterView(await window.socialVault.content.saveFilterView({
        id: view.id,
        name: view.name,
        state: reconciledState
      }))
    }
    await applyFilters()
    notice.value = `已应用筛选视图“${view.name}”。`
  } catch (cause) {
    error.value = `无法应用筛选视图：${messageOf(cause)}`
  } finally {
    filterViewBusy.value = false
  }
}

function openFilterViewDialog(): void {
  if (filterViewBusy.value) return
  filterViewPreviouslyFocused = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
  filterViewName.value = ''
  filterViewDialogError.value = ''
  filterViewDialogOpen.value = true
  void nextTick(() => filterViewNameInput.value?.focus())
}

function closeFilterViewDialog(): void {
  if (filterViewBusy.value) return
  filterViewDialogOpen.value = false
  filterViewDialogError.value = ''
  restoreFilterViewDialogFocus()
}

function restoreFilterViewDialogFocus(): void {
  const returnFocus = filterViewPreviouslyFocused
  filterViewPreviouslyFocused = null
  void nextTick(() => returnFocus?.focus())
}

function onFilterViewDialogKeydown(event: KeyboardEvent): void {
  if (!filterViewDialogOpen.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeFilterViewDialog()
    return
  }
  if (event.key !== 'Tab' || !filterViewDialog.value) return
  const focusable = [...filterViewDialog.value.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
  )]
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function createFilterView(): Promise<void> {
  if (filterViewBusy.value) return
  const name = filterViewName.value.trim()
  if (!name) {
    filterViewDialogError.value = '请输入视图名称。'
    return
  }
  filterViewBusy.value = true
  filterViewDialogError.value = ''
  error.value = ''
  notice.value = ''
  try {
    filters.tags = tagsFromInput(filterTagsInput.value)
    filterTagsInput.value = tagsToInput(filters.tags)
    const saved = await window.socialVault.content.saveFilterView({
      name,
      state: contentFilterViewStateFromFilters(filters)
    })
    replaceFilterView(saved)
    selectedFilterViewId.value = saved.id
    filterViewDialogOpen.value = false
    restoreFilterViewDialogFocus()
    notice.value = `筛选视图“${saved.name}”已保存。`
  } catch (cause) {
    filterViewDialogError.value = messageOf(cause)
  } finally {
    filterViewBusy.value = false
  }
}

async function updateSelectedFilterView(): Promise<void> {
  const view = selectedFilterView.value
  if (!view || filterViewBusy.value) return
  filterViewBusy.value = true
  error.value = ''
  notice.value = ''
  try {
    filters.tags = tagsFromInput(filterTagsInput.value)
    filterTagsInput.value = tagsToInput(filters.tags)
    const saved = await window.socialVault.content.saveFilterView({
      id: view.id,
      name: view.name,
      state: contentFilterViewStateFromFilters(filters)
    })
    replaceFilterView(saved)
    notice.value = `筛选视图“${saved.name}”已更新。`
  } catch (cause) {
    error.value = `无法更新筛选视图：${messageOf(cause)}`
  } finally {
    filterViewBusy.value = false
  }
}

async function deleteSelectedFilterView(): Promise<void> {
  const view = selectedFilterView.value
  if (!view || filterViewBusy.value) return
  const confirmed = await confirmDialog({
    title: '删除筛选视图',
    description: `确认删除“${view.name}”？`,
    confirmLabel: '删除',
    tone: 'danger'
  })
  if (!confirmed) return
  filterViewBusy.value = true
  error.value = ''
  notice.value = ''
  try {
    await window.socialVault.content.deleteFilterView(view.id)
    filterViews.value = filterViews.value.filter((item) => item.id !== view.id)
    selectedFilterViewId.value = ''
    notice.value = `筛选视图“${view.name}”已删除。`
  } catch (cause) {
    error.value = `无法删除筛选视图：${messageOf(cause)}`
  } finally {
    filterViewBusy.value = false
  }
}

function restoreAccountSortPreference(accountId = filters.accountId): void {
  const preference = readContentSortPreference(accountId)
  filters.sort = preference.sort
  filters.order = preference.order
}

async function resetFilters(): Promise<void> {
  Object.assign(filters, createDefaultContentSearchFilters())
  restoreAccountSortPreference('')
  filterTagsInput.value = ''
  selectedFilterViewId.value = ''
  advancedFiltersOpen.value = false
  pageOffset.value = 0
  selectedContentIds.value = []
  notice.value = ''
  await Promise.all([loadItems(0), loadTagFacets()])
}

async function goToPage(direction: 'previous' | 'next'): Promise<void> {
  const target = direction === 'previous'
    ? Math.max(0, pageOffset.value - pageLimit.value)
    : pageOffset.value + pageLimit.value
  selectedContentIds.value = []
  await loadItems(target)
}

function toggleFilterTag(tag: string): void {
  filters.tags = toggleSelectedTag(tagsFromInput(filterTagsInput.value), tag)
  filterTagsInput.value = tagsToInput(filters.tags)
}

function filterHasTag(tag: string): boolean {
  return tagsFromInput(filterTagsInput.value).some((item) => item === tag)
}

function togglePageSelection(): void {
  selectedContentIds.value = allPageSelected.value ? [] : items.value.map((item) => item.id)
}

async function runBulkUpdate(input: {
  isBookmarked?: boolean
  tagChange?: { action: 'add' | 'remove'; tags: string[] }
}): Promise<void> {
  if (selectedContentIds.value.length === 0 || batchSaving.value) return
  batchSaving.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await window.socialVault.content.bulkUpdate({
      contentIds: [...selectedContentIds.value],
      ...input
    })
    notice.value = `已更新 ${result.updatedCount} 条内容。`
    if (input.tagChange) batchTagsInput.value = ''
    await Promise.all([loadItems(pageOffset.value), loadTagFacets()])
    await loadDetail(selectedId.value)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    batchSaving.value = false
  }
}

async function updateSelectedTags(action: 'add' | 'remove'): Promise<void> {
  const tags = tagsFromInput(batchTagsInput.value)
  if (tags.length === 0) {
    error.value = '请先输入要添加或移除的标签。'
    return
  }
  await runBulkUpdate({ tagChange: { action, tags } })
}

async function saveMetadata(): Promise<void> {
  if (!detail.value || saving.value) return
  const targetId = detail.value.id
  const sequence = ++saveSequence
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await window.socialVault.content.update({
      id: targetId,
      note: edit.note,
      tags: tagsFromInput(edit.tags)
    })
    if (sequence !== saveSequence) return
    notice.value = '备注与标签已保存。'
    await Promise.all([loadItems(pageOffset.value), loadTagFacets()])
    if (selectedId.value === targetId) {
      detail.value = result
      edit.note = result.note
      edit.tags = tagsToInput(result.tags)
    }
  } catch (cause) {
    if (sequence === saveSequence) error.value = messageOf(cause)
  } finally {
    if (sequence === saveSequence) saving.value = false
  }
}

async function toggleDetailBookmark(): Promise<void> {
  if (!detail.value || saving.value) return
  const targetId = detail.value.id
  const bookmarked = !detail.value.isBookmarked
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await window.socialVault.content.update({ id: targetId, isBookmarked: bookmarked })
    detail.value = result
    notice.value = bookmarked ? '已加入本地收藏。' : '已取消本地收藏。'
    await loadItems(pageOffset.value)
    if (selectedId.value === targetId) detail.value = result
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    saving.value = false
  }
}

async function exportFiltered(): Promise<void> {
  if (exportBusy.value) return
  exportBusy.value = true
  error.value = ''
  notice.value = ''
  try {
    filters.tags = tagsFromInput(filterTagsInput.value)
    filterTagsInput.value = tagsToInput(filters.tags)
    const query = contentSearchQueryFromFilters(filters, 0)
    delete query.limit
    delete query.offset
    const result: ExportDataResult = await window.socialVault.content.exportFiltered({
      query,
      format: exportFormat.value,
      includeSnapshots: exportFormat.value === 'json' && exportSnapshots.value
    })
    notice.value = result.cancelled
      ? '已取消导出。'
      : `已导出 ${result.exportedContentCount} 条内容到 ${result.fileName ?? '文件'}。`
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    exportBusy.value = false
  }
}

async function openOriginal(): Promise<void> {
  if (!detail.value?.url || openingOriginalId.value) return
  const targetId = detail.value.id
  openingOriginalId.value = targetId
  error.value = ''
  try {
    await window.socialVault.content.openOriginal(targetId)
  } catch (cause) {
    error.value = `无法打开原帖：${messageOf(cause)}`
  } finally {
    if (openingOriginalId.value === targetId) openingOriginalId.value = null
  }
}

async function copyOriginalUrl(value: Pick<ContentSummary, 'id' | 'title' | 'url'>): Promise<void> {
  if (!value.url || copyingOriginalId.value) return
  copyingOriginalId.value = value.id
  error.value = ''
  notice.value = ''
  try {
    await navigator.clipboard.writeText(value.url)
    notice.value = `已复制《${value.title || '未命名内容'}》的原帖链接。`
  } catch (cause) {
    error.value = `无法复制原帖链接：${messageOf(cause)}`
  } finally {
    if (copyingOriginalId.value === value.id) copyingOriginalId.value = null
  }
}

async function copySelectedOriginalUrls(): Promise<void> {
  if (selectedContentIds.value.length === 0 || batchCopying.value) return
  const selectedIds = new Set(selectedContentIds.value)
  const selectedItems = items.value.filter((item) => selectedIds.has(item.id))
  const copyableCount = selectedItems.filter((item) => item.url.trim()).length
  const missingCount = selectedItems.length - copyableCount
  const urls = selectedContentOriginalUrls(items.value, selectedContentIds.value)
  const duplicateCount = Math.max(0, copyableCount - urls.length)
  error.value = ''
  notice.value = ''
  if (urls.length === 0) {
    error.value = `所选 ${selectedItems.length} 条内容均没有可复制的原帖链接。`
    return
  }
  batchCopying.value = true
  try {
    await navigator.clipboard.writeText(urls.join('\n'))
    const details = [
      missingCount > 0 ? `${missingCount} 条无链接` : '',
      duplicateCount > 0 ? `${duplicateCount} 条链接重复` : ''
    ].filter(Boolean)
    notice.value = `已复制 ${urls.length} 个原帖链接${details.length > 0 ? `，跳过${details.join('、')}` : ''}。`
  } catch (cause) {
    error.value = `无法批量复制原帖链接：${messageOf(cause)}`
  } finally {
    batchCopying.value = false
  }
}

function metricValue(item: ContentSummary, metricId: ContentMetricId): number | null {
  return contentMetricValue(item.latestSnapshot, metricId)
}

function metricDelta(item: ContentSummary, metricId: ContentMetricId): number | null {
  return contentMetricDelta(item.latestSnapshot, item.previousSnapshot, metricId)
}

function snapshotMetricWidth(
  snapshot: ContentSnapshot,
  metricId: ContentMetricId,
  value: ContentDetail
): number {
  const current = contentMetricValue(snapshot, metricId)
  if (current === null || current <= 0) return 0
  const maximum = Math.max(0, ...value.snapshots.map((item) => contentMetricValue(item, metricId) ?? 0))
  return maximum > 0 ? Math.max(2, (current / maximum) * 100) : 0
}

function snapshotSecondaryLabel(snapshot: ContentSnapshot, primary: ContentMetricId | null): string {
  const values = metricDefinitions.value
    .filter((definition) => definition.id !== primary && contentMetricValue(snapshot, definition.id) !== null)
    .slice(0, 2)
    .map((definition) => `${formatContentMetric(contentMetricValue(snapshot, definition.id), definition)} ${definition.label}`)
  return values.join(' · ') || '暂无其他指标'
}

function metricGroupLabel(group: ContentMetricDefinition['group']): string {
  return { reach: '流量', engagement: '互动', conversion: '转化', other: '其他' }[group]
}

async function refreshContent(): Promise<void> {
  await Promise.all([loadItems(pageOffset.value), loadTagFacets()])
  await loadDetail(selectedId.value)
}

watch(selectedId, (id) => void loadDetail(id))
watch(
  [() => filters.accountId, () => filters.platformId, () => filters.groupId],
  () => void loadTagFacets()
)
watch(
  () => filters.accountId,
  (accountId) => restoreAccountSortPreference(accountId),
  { flush: 'sync' }
)
watch(
  [() => filters.sort, () => filters.order],
  ([sort, order]) => {
    persistContentSortPreference(filters.accountId, { sort, order })
  }
)
watch(historyMetricDefinitions, (definitions) => {
  if (definitions.some((definition) => definition.id === selectedHistoryMetricId.value)) return
  selectedHistoryMetricId.value = definitions[0]?.id ?? null
}, { immediate: true })

onMounted(async () => {
  document.addEventListener('keydown', onFilterViewDialogKeydown, true)
  removeContentListener = window.socialVault.content.onChanged(() => void refreshContent())
  await Promise.all([
    (async () => {
      try {
        const [platformResult, accountResult, groupResult] = await Promise.all([
          window.socialVault.platforms.list(),
          window.socialVault.accounts.list(),
          window.socialVault.groups.list()
        ])
        platforms.value = platformResult
        accounts.value = accountResult
        groups.value = groupResult
        filterReferencesLoaded.value = true
      } catch (cause) {
        error.value = messageOf(cause)
      }
    })(),
    loadFilterViews()
  ])
  await Promise.all([loadItems(0), loadTagFacets()])
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onFilterViewDialogKeydown, true)
  removeContentListener?.()
  removeContentListener = null
})
</script>

<template>
  <div class="feature-page content-page">
    <header class="page-header feature-header">
      <div><span class="page-eyebrow">内容资料库</span><h1>内容中心</h1><p>搜索、整理并导出账号内容与指标快照</p></div>
      <span class="header-count">{{ total }} 条内容</span>
    </header>

    <div v-if="error" class="alert error"><span>{{ error }}</span><button type="button" @click="error = ''">关闭</button></div>
    <div v-if="notice" class="alert success"><span>{{ notice }}</span><button type="button" @click="notice = ''">关闭</button></div>

    <form class="filter-bar content-filter-bar" role="search" :aria-busy="filterViewBusy" @submit.prevent="applyFilters" @keydown.esc="advancedFiltersOpen = false">
      <fieldset class="content-filter-fields" :disabled="filterViewBusy">
      <div class="content-filter-primary">
        <label class="filter-search">
          <span>搜索</span>
          <span class="filter-search-control">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="10.5" cy="10.5" r="5.5" />
              <path d="m15 15 4 4" />
            </svg>
            <input v-model="filters.keyword" type="search" aria-label="搜索内容" placeholder="搜索标题、摘要、标签或备注" />
          </span>
        </label>
        <label><span>账号</span><select v-model="filters.accountId"><option value="">全部账号</option><option v-for="account in accounts" :key="account.id" :value="account.id">{{ accountDisplayName(account, platformName(account.platformId)) }}</option></select></label>
        <label><span>平台</span><select v-model="filters.platformId"><option value="">全部平台</option><option v-for="platform in platforms" :key="platform.id" :value="platform.id">{{ platform.name }}</option></select></label>
      </div>

      <div class="content-filter-actions">
        <button class="button filter-more-button" type="button" :aria-expanded="advancedFiltersOpen" @click="advancedFiltersOpen = !advancedFiltersOpen">
          {{ advancedFiltersOpen ? '收起筛选' : '更多筛选' }}<span v-if="activeFilterCount > 0">{{ activeFilterCount }}</span>
        </button>
        <button class="button" type="button" @click="resetFilters">重置</button>
        <button class="button primary" type="submit">应用筛选</button>
      </div>

      <div v-if="advancedFiltersOpen" class="content-filter-advanced" aria-label="高级筛选">
        <label><span>分组</span><select v-model="filters.groupId"><option value="">全部分组</option><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option></select></label>
        <label><span>类型</span><select v-model="filters.type"><option value="">全部类型</option><option v-for="option in contentTypeOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
        <label><span>本地收藏</span><select v-model="filters.bookmark"><option value="all">全部内容</option><option value="bookmarked">仅收藏</option><option value="unbookmarked">未收藏</option></select></label>
        <label class="content-sync-warning-filter"><span>同步状态</span><span><input v-model="filters.syncWarningOnly" type="checkbox" /> 来自部分完成同步</span></label>
        <label class="filter-tags-input"><span>标签</span><input v-model="filterTagsInput" placeholder="使用逗号分隔多个标签" /></label>
        <label><span>标签匹配</span><select v-model="filters.tagMatch"><option value="all">同时包含全部</option><option value="any">包含任一标签</option></select></label>
        <label><span>发布开始</span><input v-model="filters.publishedFrom" type="date" :max="filters.publishedTo || undefined" /></label>
        <label><span>发布结束</span><input v-model="filters.publishedTo" type="date" :min="filters.publishedFrom || undefined" /></label>
        <label><span>采集开始</span><input v-model="filters.capturedFrom" type="date" :max="filters.capturedTo || undefined" /></label>
        <label><span>采集结束</span><input v-model="filters.capturedTo" type="date" :min="filters.capturedFrom || undefined" /></label>
        <label><span>排序依据</span><select v-model="filters.sort"><option value="relevance">相关度</option><option value="published">发布时间</option><option value="captured">采集时间</option><option value="views">浏览量</option><option value="interactions">互动量</option></select></label>
        <label><span>顺序</span><select v-if="filters.sort === 'relevance'" disabled><option>最相关优先</option></select><select v-else v-model="filters.order"><option value="desc">从高到低</option><option value="asc">从低到高</option></select></label>
        <label><span>每页</span><select v-model.number="filters.pageSize"><option :value="25">25 条</option><option :value="50">50 条</option><option :value="100">100 条</option></select></label>
        <div v-if="tagFacets.length > 0" class="content-tag-facets" aria-label="常用标签">
          <button v-for="facet in tagFacets" :key="facet.tag" type="button" :class="{ active: filterHasTag(facet.tag) }" @click="toggleFilterTag(facet.tag)">{{ facet.tag }}<span>{{ facet.count }}</span></button>
        </div>
      </div>

      <div class="content-filter-footer">
        <div class="content-filter-view-controls">
          <span>筛选视图</span>
          <select v-model="selectedFilterViewId" aria-label="已保存的筛选视图" :disabled="filterViewBusy" @change="applySelectedFilterView">
            <option value="">临时视图</option>
            <option v-for="view in filterViews" :key="view.id" :value="view.id">{{ view.name }}</option>
          </select>
          <button class="button content-filter-view-save" type="button" aria-label="保存当前筛选为新视图" title="保存当前筛选为新视图" :disabled="filterViewBusy" @click="openFilterViewDialog">保存</button>
          <button v-if="selectedFilterView" class="button content-filter-view-icon" type="button" aria-label="更新筛选视图" title="更新筛选视图" :disabled="filterViewBusy" @click="updateSelectedFilterView"><span aria-hidden="true">↻</span></button>
          <button v-if="selectedFilterView" class="button content-filter-view-icon content-filter-view-delete" type="button" aria-label="删除筛选视图" title="删除筛选视图" :disabled="filterViewBusy" @click="deleteSelectedFilterView"><span aria-hidden="true">×</span></button>
        </div>
        <div class="content-export-controls">
          <span>导出当前筛选</span>
          <select v-model="exportFormat" aria-label="导出格式"><option value="csv">CSV</option><option value="json">JSON</option></select>
          <label v-if="exportFormat === 'json'" class="content-inline-check"><input v-model="exportSnapshots" type="checkbox" /> 快照</label>
          <button class="button" type="button" :disabled="exportBusy" @click="exportFiltered">{{ exportBusy ? '导出中…' : '导出' }}</button>
        </div>
      </div>
      </fieldset>
    </form>

    <div v-if="filterViewDialogOpen" class="modal-backdrop" @pointerdown.self="closeFilterViewDialog">
      <section ref="filterViewDialog" class="modal compact content-filter-view-dialog" role="dialog" aria-modal="true" aria-labelledby="content-filter-view-title" aria-describedby="content-filter-view-description">
        <div class="modal-head">
          <div><span class="page-eyebrow">筛选视图</span><h2 id="content-filter-view-title">保存当前筛选</h2><p id="content-filter-view-description">名称用于在内容中心快速切换。</p></div>
          <button type="button" aria-label="关闭保存筛选视图" @click="closeFilterViewDialog">×</button>
        </div>
        <label>视图名称<input ref="filterViewNameInput" v-model="filterViewName" maxlength="40" placeholder="例如：知乎本月复盘" @keydown.enter.prevent="createFilterView" /></label>
        <p v-if="filterViewDialogError" class="content-filter-view-error" role="alert">{{ filterViewDialogError }}</p>
        <div class="modal-actions"><button class="button" type="button" :disabled="filterViewBusy" @click="closeFilterViewDialog">取消</button><button class="button primary" type="button" :disabled="filterViewBusy || !filterViewName.trim()" @click="createFilterView">{{ filterViewBusy ? '保存中…' : '保存' }}</button></div>
      </section>
    </div>

    <section v-if="selectedContentIds.length > 0" class="content-batch-toolbar" aria-label="批量整理">
      <strong>已选择 {{ selectedContentIds.length }} 条</strong>
      <input v-model="batchTagsInput" aria-label="批量标签" placeholder="输入标签，使用逗号分隔" />
      <button class="button" type="button" :disabled="batchSaving" @click="updateSelectedTags('add')">添加标签</button>
      <button class="button" type="button" :disabled="batchSaving" @click="updateSelectedTags('remove')">移除标签</button>
      <span class="content-batch-divider"></span>
      <button class="button" type="button" :disabled="batchSaving" @click="runBulkUpdate({ isBookmarked: true })">收藏</button>
      <button class="button" type="button" :disabled="batchSaving" @click="runBulkUpdate({ isBookmarked: false })">取消收藏</button>
      <button class="button" type="button" :disabled="batchCopying" @click="copySelectedOriginalUrls"><span aria-hidden="true">⧉</span> {{ batchCopying ? '复制中…' : '复制链接' }}</button>
      <button class="content-clear-selection" type="button" @click="selectedContentIds = []">清除选择</button>
    </section>

    <section class="content-workspace">
      <aside class="content-results-pane">
        <header class="content-results-head">
          <label><input type="checkbox" :checked="allPageSelected" :disabled="items.length === 0" @change="togglePageSelection" /> 选择本页</label>
          <span>{{ pagination.first }}–{{ pagination.last }} / {{ total }}</span>
        </header>
        <div class="content-results" aria-label="内容列表">
          <div v-if="loading" class="feature-loading">正在读取内容索引…</div>
          <div v-else-if="items.length === 0" class="feature-empty compact">
            <span>▤</span><strong>没有匹配的内容</strong>
            <p v-if="accounts.length === 0">请先在账号中心添加本人账号并完成首次同步。</p>
            <p v-else>调整筛选条件，或前往账号中心同步最新内容。</p>
          </div>
          <article v-for="item in items" v-else :key="item.id" class="content-row" :class="{ active: selectedId === item.id }">
            <label class="content-row-check" @click.stop><input v-model="selectedContentIds" type="checkbox" :value="item.id" :aria-label="`选择《${item.title || '未命名内容'}》`" /></label>
            <span class="content-kind">{{ contentTypeLabel(item.type) }}</span>
            <span class="content-row-main">
              <span class="content-row-title">
                <button class="content-row-open" type="button" :aria-current="selectedId === item.id ? 'true' : undefined" @click="selectedId = item.id"><i v-if="item.isBookmarked" title="本地收藏">★</i>{{ item.title || '未命名内容' }}</button>
                <button
                  v-if="item.url"
                  class="content-copy-link"
                  type="button"
                  :disabled="copyingOriginalId === item.id"
                  :aria-label="`复制《${item.title || '未命名内容'}》原帖链接`"
                  :title="copyingOriginalId === item.id ? '正在复制原帖链接' : '复制原帖链接'"
                  @click="copyOriginalUrl(item)"
                ><span aria-hidden="true">⧉</span></button>
              </span>
              <button class="content-row-secondary" type="button" @click="selectedId = item.id">
                <small>{{ item.accountAlias }} · {{ platformName(item.platformId) }} · 发布 {{ formatDate(item.publishedAt) }}</small>
                <em>{{ item.bodyExcerpt || '没有正文摘要' }}</em>
                <span v-if="item.tags.length > 0" class="content-row-tags"><b v-for="tag in item.tags.slice(0, 3)" :key="tag">{{ tag }}</b></span>
              </button>
            </span>
            <span class="content-row-metric"><strong>{{ formatNumber(primaryContentMetric(item).value) }}</strong><small>{{ primaryContentMetric(item).label }}</small></span>
          </article>
        </div>
        <footer class="content-pagination">
          <button class="button" type="button" :disabled="loading || pageOffset === 0" @click="goToPage('previous')">上一页</button>
          <span>第 {{ pagination.page }} / {{ pagination.pageCount }} 页</span>
          <button class="button" type="button" :disabled="loading || !hasMore" @click="goToPage('next')">下一页</button>
        </footer>
      </aside>

      <article class="content-detail-panel">
        <div v-if="detailLoading" class="feature-loading">正在读取内容快照…</div>
        <div v-else-if="!detail || !selectedSummary" class="feature-empty"><span>⌁</span><strong>选择一条内容查看详情</strong><p>可以查看原帖、指标历史并整理本地标签和备注。</p></div>
        <template v-else>
          <header class="content-detail-head">
            <div><span class="content-kind">{{ contentTypeLabel(detail.type) }}</span><span class="content-detail-title"><h2>{{ detail.title || '未命名内容' }}</h2><button
              v-if="detail.url"
              class="content-copy-link"
              type="button"
              :disabled="copyingOriginalId === detail.id"
              :aria-label="`复制《${detail.title || '未命名内容'}》原帖链接`"
              :title="copyingOriginalId === detail.id ? '正在复制原帖链接' : '复制原帖链接'"
              @click="copyOriginalUrl(detail)"
            ><span aria-hidden="true">⧉</span></button></span><p>{{ detail.accountAlias }} · {{ platformName(detail.platformId) }} · 发布于 {{ formatDate(detail.publishedAt) }} · 采集于 {{ formatDate(detail.lastCapturedAt, true) }}</p></div>
            <div class="content-detail-actions">
              <span class="snapshot-time">最新快照 {{ formatDate(detail.latestSnapshot?.capturedAt, true) }}</span>
              <div>
                <button class="button content-bookmark-button" type="button" :disabled="saving" :aria-pressed="detail.isBookmarked" @click="toggleDetailBookmark">{{ detail.isBookmarked ? '★ 已收藏' : '☆ 收藏' }}</button>
                <button
                  v-if="detail.url"
                  class="button content-original-button"
                  type="button"
                  :disabled="openingOriginalId === detail.id"
                  :aria-busy="openingOriginalId === detail.id"
                  :aria-label="`在账号浏览器中查看《${detail.title || '未命名内容'}》原帖`"
                  @click="openOriginal"
                >
                  {{ openingOriginalId === detail.id ? '正在打开…' : '↗ 查看原帖' }}
                </button>
                <span v-else class="content-original-unavailable">暂无原帖链接</span>
              </div>
            </div>
          </header>
          <p v-if="detail.bodyExcerpt" class="content-excerpt">{{ detail.bodyExcerpt }}</p>

          <section class="content-metric-grid">
            <article v-for="definition in metricDefinitions" :key="definition.id" :data-metric-group="definition.group">
              <span>{{ definition.label }}<em>{{ metricGroupLabel(definition.group) }}</em></span>
              <strong>{{ formatContentMetric(metricValue(detail, definition.id), definition) }}</strong>
              <small :class="{ positive: (metricDelta(detail, definition.id) ?? 0) > 0 }">{{ formatContentMetricDelta(metricDelta(detail, definition.id), definition) }}</small>
            </article>
          </section>

          <section class="snapshot-section">
            <div class="feature-card-head snapshot-section-head">
              <div><h3>快照历史</h3><p>保留每次采集到的可靠指标记录</p></div>
              <div class="snapshot-controls">
                <label v-if="historyMetricDefinitions.length > 0">查看指标<select v-model="selectedHistoryMetricId"><option v-for="definition in historyMetricDefinitions" :key="definition.id" :value="definition.id">{{ definition.label }}</option></select></label>
                <span>{{ detail.snapshotCount }} 次</span>
              </div>
            </div>
            <p v-if="detail.snapshotsTruncated" class="snapshot-limit-note">当前显示最近 {{ detail.snapshots.length }} 次变化，完整历史可通过数据导出获取。</p>
            <div v-if="detail.snapshots.length === 0" class="compact-empty"><span>暂无指标快照</span></div>
            <div v-for="snapshot in detail.snapshots.slice().reverse()" :key="snapshot.capturedAt" class="snapshot-row">
              <span>{{ formatDate(snapshot.capturedAt, true) }}</span>
              <i><b v-if="historyMetricDefinition && contentMetricValue(snapshot, historyMetricDefinition.id) !== null" :style="{ width: `${snapshotMetricWidth(snapshot, historyMetricDefinition.id, detail)}%` }"></b></i>
              <strong v-if="historyMetricDefinition">{{ formatContentMetric(contentMetricValue(snapshot, historyMetricDefinition.id), historyMetricDefinition) }} {{ historyMetricDefinition.label }}</strong><strong v-else>暂无可用指标</strong>
              <small>{{ snapshotSecondaryLabel(snapshot, historyMetricDefinition?.id ?? null) }}</small>
            </div>
          </section>

          <form class="metadata-form" @submit.prevent="saveMetadata">
            <div class="feature-card-head"><div><h3>内容整理</h3><p>本地标签和备注不会写回平台</p></div></div>
            <label>标签<input v-model="edit.tags" placeholder="使用逗号分隔" /></label>
            <label>备注<textarea v-model="edit.note" rows="3" maxlength="1000" placeholder="记录选题、复盘或负责人"></textarea></label>
            <div class="form-actions"><button class="button primary" :disabled="saving" type="submit">{{ saving ? '保存中…' : '保存备注' }}</button></div>
          </form>
        </template>
      </article>
    </section>
  </div>
</template>
