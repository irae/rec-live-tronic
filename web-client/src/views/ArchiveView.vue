<template>
  <div class="archive-view">
    <section class="hero">
      <span class="stamp"><span class="blip"></span>captured live</span>
      <h1>Your<br>Lineup</h1>
      <p class="lede">Every set you pulled off the stream, kept as a file you own. Newest at the top of the bill.</p>
    </section>

    <div class="toolbar">
      <p class="eyebrow">Recorded sets <span class="count">{{ recordings.length }}</span></p>
      <button
        type="button"
        class="delete-toggle"
        :class="{ 'delete-toggle--active': deleteMode }"
        @click="deleteMode = !deleteMode"
      >{{ deleteMode ? "Done" : "🗑 Quick delete" }}</button>
    </div>

    <RecordingList
      :recordings="recordings"
      :empty-message="recordings.length === 0 ? 'No finished recordings yet.' : ''"
      :delete-mode="deleteMode"
      @select="selectRecording"
      @delete="handleDelete"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";
import RecordingList from "../components/RecordingList.vue";
import { useToast } from "../composables/useToast";

const { toast } = useToast();

interface Recording {
  id: string;
  title: string;
  stage: string | null;
  quality: string;
  startAt: string;
  stopAt: string;
  status: string;
  url: string;
  cookieId: string | null;
  cutFromId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const router = useRouter();

const recordings = ref<Recording[]>([]);
const deleteMode = ref(false);
const deletingIds = ref<Set<string>>(new Set());

onMounted(async () => {
  try {
    const all = await api.listRecordings("recorded");
    recordings.value = all;
  } catch (error) {
    console.error("Failed to load archive:", error);
  }
});

function selectRecording(id: string): void {
  router.push({ name: "detail", params: { id } });
}

async function handleDelete(id: string): Promise<void> {
  if (deletingIds.value.has(id)) return;
  deletingIds.value.add(id);
  try {
    await api.deleteRecordingFile(id);
    recordings.value = recordings.value.filter((rec) => rec.id !== id);
    toast("Moved to Trash");
  } catch (error) {
    console.error("Failed to delete recording:", error);
    toast(error instanceof Error ? error.message : "Failed to delete recording");
  } finally {
    deletingIds.value.delete(id);
  }
}
</script>

<style scoped>
.archive-view {
  padding: 0;
}

.hero {
  padding: 30px 0 6px;
}

.hero h1 {
  font-family: var(--disp);
  font-weight: 400;
  text-transform: uppercase;
  font-size: clamp(46px, 15vw, 118px);
  line-height: .86;
  letter-spacing: .01em;
  margin: 8px 0 0;
}

.hero .lede {
  max-width: 40ch;
  margin: 16px 0 0;
  font-size: 15px;
  color: var(--ink-soft);
}

.stamp {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--mono);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--fluoro);
  border: 2px solid var(--fluoro);
  padding: 5px 10px;
  transform: rotate(-2.5deg);
}

.stamp .blip {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--fluoro);
  animation: pulse 1.3s infinite;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 34px 0 16px;
}

.eyebrow {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: .22em;
  text-transform: uppercase;
  color: var(--ink-soft);
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  flex: 1;
}

.eyebrow::after {
  content: "";
  flex: 1;
  height: 2px;
  background: var(--line);
}

.eyebrow .count {
  color: var(--fluoro);
}

.delete-toggle {
  flex-shrink: 0;
  font-family: var(--mono);
  font-weight: 700;
  font-size: 10.5px;
  letter-spacing: .1em;
  text-transform: uppercase;
  border: 2px solid var(--line);
  background: var(--paper);
  color: var(--ink-soft);
  padding: 7px 12px;
  cursor: pointer;
  transition: all .12s;
}

.delete-toggle:hover {
  border-color: var(--fluoro);
  color: var(--fluoro);
  box-shadow: 2px 2px 0 var(--ink);
  transform: translate(-1px, -1px);
}

.delete-toggle--active {
  background: var(--fluoro);
  border-color: var(--fluoro);
  color: #fff;
}

@keyframes pulse {
  0%,100% { opacity:1; transform:scale(1); }
  50% { opacity:.35; transform:scale(.7); }
}
</style>
