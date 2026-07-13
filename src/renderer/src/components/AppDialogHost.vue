<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { dialogState, settleDialog } from '../ui/dialog'

const dialog = ref<HTMLElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
let previouslyFocused: HTMLElement | null = null

watch(dialogState, (request) => {
  if (request) {
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void nextTick(() => cancelButton.value?.focus())
  } else {
    previouslyFocused?.focus()
    previouslyFocused = null
  }
})

function onKeydown(event: KeyboardEvent): void {
  if (!dialogState.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    settleDialog(false)
    return
  }
  if (event.key !== 'Tab' || !dialog.value) return
  const focusable = [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="dialogState" class="dialog-layer" @pointerdown.self="settleDialog(false)">
        <section
          ref="dialog"
          class="app-dialog"
          :class="`tone-${dialogState.tone}`"
          role="alertdialog"
          aria-modal="true"
          :aria-labelledby="`dialog-title-${dialogState.id}`"
          :aria-describedby="`dialog-copy-${dialogState.id}`"
        >
          <div class="dialog-icon" aria-hidden="true">
            <svg v-if="dialogState.tone === 'danger'" viewBox="0 0 24 24"><path d="M12 8v5m0 3h.01" /><path d="M10.3 3.8 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z" /></svg>
            <svg v-else-if="dialogState.tone === 'warning'" viewBox="0 0 24 24"><path d="M12 7v6m0 3h.01" /><circle cx="12" cy="12" r="9" /></svg>
            <svg v-else viewBox="0 0 24 24"><path d="m8 12 2.6 2.6L16.5 9" /><circle cx="12" cy="12" r="9" /></svg>
          </div>
          <div class="dialog-content">
            <span class="dialog-kicker">{{ dialogState.tone === 'danger' ? '需要确认' : dialogState.tone === 'warning' ? '请确认操作' : '确认操作' }}</span>
            <h2 :id="`dialog-title-${dialogState.id}`">{{ dialogState.title }}</h2>
            <p :id="`dialog-copy-${dialogState.id}`">{{ dialogState.description }}</p>
            <dl v-if="dialogState.details.length" class="dialog-details">
              <div v-for="detail in dialogState.details" :key="detail"><dd>{{ detail }}</dd></div>
            </dl>
          </div>
          <div class="dialog-actions">
            <button ref="cancelButton" class="button" type="button" @click="settleDialog(false)">{{ dialogState.cancelLabel }}</button>
            <button class="button dialog-confirm" type="button" @click="settleDialog(true)">{{ dialogState.confirmLabel }}</button>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
