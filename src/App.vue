<script setup lang="ts">
import { RouterView } from 'vue-router'
</script>

<template>
  <RouterView v-slot="{ Component }">
    <KeepAlive include="LibraryView">
      <component :is="Component" />
    </KeepAlive>
  </RouterView>
</template>
