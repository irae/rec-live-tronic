<template>
  <div id="app" class="app">
    <nav class="navbar">
      <h1>rec-live-tronic</h1>
      <div class="nav-buttons">
        <button @click="view = 'archive'" :class="{ active: view === 'archive' }">Archive</button>
        <button @click="view = 'schedule'" :class="{ active: view === 'schedule' }">Schedule</button>
      </div>
    </nav>

    <main class="content">
      <ArchiveView v-show="view === 'archive'" @select-recording="selectRecording" :selected-id="selectedId" />
      <ScheduleView v-show="view === 'schedule'" @select-recording="selectRecording" :selected-id="selectedId" />
      <RecordingDetail v-show="view === 'detail'" :recording-id="selectedId" @back="view = 'archive'" />
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import ArchiveView from "./views/ArchiveView.vue";
import ScheduleView from "./views/ScheduleView.vue";
import RecordingDetail from "./views/RecordingDetail.vue";

const view = ref("archive");
const selectedId = ref<string | null>(null);

function selectRecording(id: string): void {
  selectedId.value = id;
  view.value = "detail";
}
</script>

<style scoped>
.app {
  font-family: system-ui, -apple-system, sans-serif;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: #f5f5f5;
}

.navbar {
  background: white;
  border-bottom: 1px solid #ddd;
  padding: 1rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.navbar h1 {
  margin: 0;
  font-size: 1.5rem;
}

.nav-buttons {
  display: flex;
  gap: 0.5rem;
}

.nav-buttons button {
  padding: 0.5rem 1rem;
  background: #f0f0f0;
  border: 1px solid #ddd;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
}

.nav-buttons button.active {
  background: #007bff;
  color: white;
  border-color: #0056b3;
}

.nav-buttons button:hover {
  background: #e0e0e0;
}

.nav-buttons button.active:hover {
  background: #0056b3;
}

.content {
  flex: 1;
  padding: 1rem;
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
}
</style>
