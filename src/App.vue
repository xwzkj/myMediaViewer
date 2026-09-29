<script setup lang="ts">
import { RouterView } from 'vue-router'
import { routeCacheKey } from './route-cache-key'
</script>

<template>
  <RouterView v-slot="{ Component, route }">
    <KeepAlive include="LibraryView" :max="16">
      <component :is="Component" :key="routeCacheKey(route)" />
    </KeepAlive>
  </RouterView>
</template>
