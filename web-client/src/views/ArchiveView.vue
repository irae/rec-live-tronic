<template>
  <div class="archive-view">
    <h2>Archive</h2>
    <p v-if="!recordings.length" class="empty">No finished recordings yet.</p>
    <div v-else class="recordings-list">
      <div v-for="rec in recordings" :key="rec.id" class="recording-item" @click="selectRecording(rec.id)">
        <h3>{{ rec.title }}</h3>
        <p>{{ rec.status }}</p>
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
}

defineProps<{
  selectedId: string | null;
}>();

defineEmits<{
  selectRecording: [id: string];
}>();

const recordings = ref<Recording[]>([]);

onMounted(async () => {
  try {
    const all = await api.listRecordings("recorded");
    recordings.value = all;
  } catch (error) {
    console.error("Failed to load archive:", error);
  }
});

function selectRecording(id: string): void {
  // Emits to parent
}
</script>

<style scoped>
.archive-view {
  padding: 1rem;
}

.archive-view h2 {
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
  margin: 0;
  font-size: 0.875rem;
  color: #666;
}
</style>
