<script setup lang="ts">
import { ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  src?: string
  fallback?: string
  label?: string
}>(), {
  src: '',
  fallback: '账',
  label: '账号头像'
})

const failed = ref(false)

watch(() => props.src, () => {
  failed.value = false
})
</script>

<template>
  <span class="avatar account-avatar" role="img" :aria-label="label">
    <img
      v-if="src && !failed"
      :src="src"
      alt=""
      decoding="async"
      loading="lazy"
      referrerpolicy="no-referrer"
      @error="failed = true"
    />
    <span v-else aria-hidden="true">{{ fallback || '账' }}</span>
  </span>
</template>

<style scoped>
.account-avatar {
  position: relative;
  flex: 0 0 auto;
  overflow: hidden;
}

.account-avatar img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
