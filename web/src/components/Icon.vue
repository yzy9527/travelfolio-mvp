<script setup lang="ts">
defineProps<{ name: string; size?: number }>()
const paths: Record<string, string> = {
  compass: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M16 8l-3 5-5 3 3-5 5-3Z',
  plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14M13 6l6 6-6 6', chevron: 'm9 5 7 7-7 7',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  book: 'M12 5c-4-3-8-2-9-1v15c3-2 6-1 9 1 3-2 6-3 9-1V4c-3-2-6-1-9 1Zm0 0v15',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6', pin: 'M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0ZM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  calendar: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM7 3v4M17 3v4M3 11h18',
  people: 'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM2 21v-3a6 6 0 0 1 12 0v3M17 3a4 4 0 0 1 0 8M18 14a5 5 0 0 1 4 4v3',
  wallet: 'M20 7H5a2 2 0 0 1 0-4h13v4M3 5v14a2 2 0 0 0 2 2h15V7M20 12h-6v5h6M17 14.5h.01',
  spark: 'm12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3ZM20 2v4M18 4h4',
  check: 'm5 12 4 4L19 6', close: 'm6 6 12 12M18 6 6 18', download: 'M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5',
  history: 'M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2', shield: 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Zm-4 10 3 3 5-6',
  logout: 'M9 4H4v16h5M9 12h12m-5-5 5 5-5 5', link: 'M10 7 8 5a4 4 0 0 0-6 6l4 4a4 4 0 0 0 6 0m2-6 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0M8 12l8-4',
  external: 'M14 3h7v7m0-7-10 10M10 3H3v18h18v-7', info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 11v6M12 7h.01',
  menu: 'M4 6h16M4 12h16M4 18h16', mail: 'M3 5h18v14H3ZM3 5l9 8 9-8', lock: 'M6 10h12v11H6ZM8 10V6a4 4 0 0 1 8 0v4', route: 'M5 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM19 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM7 6h9a4 4 0 0 1 0 8H8a4 4 0 0 0 0 8h7'
}
</script>
<template><svg :width="size || 20" :height="size || 20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.compass"/></svg></template>
