<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 28 })
</script>

<template>
  <span class="brand-glyph" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true">
    <svg viewBox="0 0 32 32" fill="none">
      <path d="M7 8.5h11.5c3.6 0 6.5 2.9 6.5 6.5v8.5H13.5A6.5 6.5 0 0 1 7 17Z" />
      <path d="M11 4.5h9.5c3.6 0 6.5 2.9 6.5 6.5v8.5h-9.5A6.5 6.5 0 0 1 11 13Z" />
      <path d="m7.5 13.5 9 5.5 9-5.5" />
    </svg>
  </span>
</template>
