<template>
  <div class="recording-detail">
    <button class="back-button" @click="goBack">← Back</button>
    <div v-if="recording" class="detail-content">
      <h2>{{ recording.title }}</h2>
      <div class="meta">
        <p><strong>Status:</strong> {{ recording.status }}</p>
        <p><strong>URL:</strong> {{ recording.url }}</p>
        <p><strong>Quality:</strong> {{ recording.quality }}</p>
        <p><strong>Starts:</strong> {{ recording.start_at }}</p>
        <p><strong>Ends:</strong> {{ recording.stop_at }}</p>
      </div>
      <div v-if="recording.status === 'recorded'" class="actions">
        <button @click="copyUrl" class="btn-primary">Copy Stream URL</button>
        <button @click="deleteRecording" class="btn-danger">Delete</button>
      </div>
    </div>
    <div v-else class="loading">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api } from "../api";

interface Recording {
  id: string;
  url: string;
  title: string;
  status: string;
  start_at: string;
  stop_at: string;
  quality: string;
}

interface Props {
  recordingId: string | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  back: [];
}>();

const recording = ref<Recording | null>(null);

onMounted(async () => {
  if (!props.recordingId) return;
  try {
    recording.value = await api.getRecording(props.recordingId);
  } catch (error) {
    console.error("Failed to load recording:", error);
  }
});

function goBack(): void {
  emit("back");
}

function copyUrl(): void {
  if (!props.recordingId) return;
  const url = `http://localhost:8787/recordings/${props.recordingId}/file`;
  navigator.clipboard.writeText(url);
  alert("URL copied to clipboard");
}

async function deleteRecording(): Promise<void> {
  if (!props.recordingId || !confirm("Delete this recording?")) return;
  try {
    await api.cancelRecording(props.recordingId);
    emit("back");
  } catch (error) {
    console.error("Failed to delete recording:", error);
  }
}
</script>

<style scoped>
.recording-detail {
  padding: 1rem;
  background: white;
  border-radius: 8px;
  max-width: 600px;
}

.back-button {
  background: none;
  border: none;
  color: #007bff;
  cursor: pointer;
  font-size: 1rem;
  padding: 0;
  margin-bottom: 1rem;
}

.back-button:hover {
  text-decoration: underline;
}

.recording-detail h2 {
  margin: 0 0 1rem 0;
}

.meta {
  background: #f9f9f9;
  padding: 1rem;
  border-radius: 4px;
  margin-bottom: 1rem;
}

.meta p {
  margin: 0.5rem 0;
  font-size: 0.95rem;
}

.actions {
  display: flex;
  gap: 0.5rem;
}

.btn-primary,
.btn-danger {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
}

.btn-primary {
  background: #007bff;
  color: white;
}

.btn-primary:hover {
  background: #0056b3;
}

.btn-danger {
  background: #dc3545;
  color: white;
}

.btn-danger:hover {
  background: #c82333;
}

.loading {
  text-align: center;
  color: #666;
  padding: 2rem;
}
</style>
