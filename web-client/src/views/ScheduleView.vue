<template>
  <div class="schedule-view">
    <h2>Schedule</h2>
    <p v-if="!recordings.length" class="empty">No scheduled or recording sessions yet.</p>
    <div v-else class="recordings-list">
      <div v-for="rec in recordings" :key="rec.id" class="recording-item" @click="selectRecording(rec.id)">
        <h3>{{ rec.title }}</h3>
        <p>{{ rec.status }}</p>
        <small>{{ rec.start_at }}</small>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api } from "../api";

interface Recording {
  id: string;
  title: string;
  status: string;
  start_at: string;
}

defineProps<{
  selectedId: string | null;
}>();

const emit = defineEmits<{
  selectRecording: [id: string];
}>();

const recordings = ref<Recording[]>([]);

onMounted(async () => {
  try {
    const scheduled = await api.listRecordings("scheduled");
    const recording = await api.listRecordings("recording");
    recordings.value = [...scheduled, ...recording];
  } catch (error) {
    console.error("Failed to load schedule:", error);
  }
});

function selectRecording(id: string): void {
  emit("selectRecording", id);
}
</script>

<style scoped>
.schedule-view {
  padding: 1rem;
}

.schedule-view h2 {
  margin: 0 0 1rem 0;
}

.empty {
  color: #666;
  font-style: italic;
}

.recordings-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 1rem;
}

.recording-item {
  background: white;
  padding: 1rem;
  border-radius: 8px;
  border: 1px solid #ddd;
  cursor: pointer;
  transition: all 0.2s;
}

.recording-item:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  transform: translateY(-2px);
}

.recording-item h3 {
  margin: 0 0 0.5rem 0;
  font-size: 1rem;
}

.recording-item p {
  margin: 0 0 0.5rem 0;
  font-size: 0.875rem;
  color: #666;
}

.recording-item small {
  display: block;
  color: #999;
  font-size: 0.75rem;
}
</style>
