<template>
  <div class="trash-view">
    <section class="hero">
      <span class="stamp"><span class="blip"></span>on the way out</span>
      <h1>Off The<br>Bill</h1>
      <p class="lede">Pulled sets, held before the wipe. Bring one back or clear it for good — nothing here is final yet.</p>
    </section>

    <p class="eyebrow">Trashed sets <span class="count">{{ trashedRecordings.length }}</span></p>

    <div v-if="error" class="error-message">{{ error }}</div>

    <div class="bin" v-if="trashedRecordings.length > 0">
      <article v-for="rec in trashedRecordings" :key="rec.id" class="crate">
        <div class="crate__top">
          <div>
            <div class="crate__meta">
              <span v-if="extractFestival(rec.title)">{{ extractFestival(rec.title) }}</span>
              <span v-if="extractFestival(rec.title)">·</span>
              <span>{{ rec.stage || "Stage" }}</span>
              <span>·</span>
              <span>{{ rec.quality || "n/a" }}</span>
            </div>
            <div class="crate__title">{{ rec.title }}</div>
          </div>
          <span class="tag"><span class="dot"></span>Trashed</span>
        </div>

        <div class="crate__facts">
          <span class="fact">Recorded <b>{{ formatDate(rec.startAt) }}</b></span>
          <span class="fact">Trashed <b>{{ relativeTime(rec.trashedAt) }}</b></span>
        </div>

        <div class="crate__purge">
          Auto-purges in <b>{{ daysUntil(purgeAt(rec.trashedAt)) }}</b> — permanent delete cannot be undone after that
        </div>

        <div class="actions">
          <button
            class="tbtn tbtn--go"
            :disabled="restoringIds.has(rec.id) || deletingIds.has(rec.id)"
            @click.prevent="handleRestore(rec.id)"
          >↺ {{ restoringIds.has(rec.id) ? "Restoring…" : "Restore" }}</button>
          <button
            class="tbtn tbtn--stop"
            :disabled="restoringIds.has(rec.id) || deletingIds.has(rec.id)"
            @click.prevent="askDeleteForever(rec.id)"
          >🗑 {{ deletingIds.has(rec.id) ? "Deleting…" : "Delete forever" }}</button>
        </div>
      </article>
    </div>
    <div v-else-if="!loading" class="empty-state">
      <p>Nothing in the bin. Trashed sets show up here before they're gone for good.</p>
    </div>

    <ConfirmDialog
      :is-open="confirmDeleteId !== null"
      title="Delete forever"
      :message="`Permanently delete “${confirmDeleteTitle}”? This cannot be undone.`"
      confirm-label="Delete forever"
      @confirm="confirmDeleteForever"
      @cancel="confirmDeleteId = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { api, type Recording } from "../api";
import ConfirmDialog from "../components/ConfirmDialog.vue";

interface TrashedRecording extends Recording {
  trashedAt: string;
}

const trashedRecordings = ref<TrashedRecording[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const restoringIds = ref<Set<string>>(new Set());
const deletingIds = ref<Set<string>>(new Set());
const confirmDeleteId = ref<string | null>(null);

const confirmDeleteTitle = computed(() => {
  return trashedRecordings.value.find((rec) => rec.id === confirmDeleteId.value)?.title ?? "";
});

async function fetchTrashed(): Promise<void> {
  try {
    error.value = null;
    const all = await api.listTrashedRecordings();
    trashedRecordings.value = all.filter(
      (rec): rec is TrashedRecording => rec.trashedAt !== null,
    );
  } catch (err) {
    console.error("Failed to load trash:", err);
    error.value = err instanceof Error ? err.message : "Failed to load trash";
  } finally {
    loading.value = false;
  }
}

let pollInterval: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  fetchTrashed();
  pollInterval = setInterval(fetchTrashed, 60_000);
});

onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval);
});

async function handleRestore(id: string): Promise<void> {
  restoringIds.value.add(id);
  try {
    error.value = null;
    await api.restoreRecording(id);
    trashedRecordings.value = trashedRecordings.value.filter((rec) => rec.id !== id);
  } catch (err) {
    console.error("Failed to restore recording:", err);
    error.value = err instanceof Error ? err.message : "Failed to restore recording";
  } finally {
    restoringIds.value.delete(id);
  }
}

function askDeleteForever(id: string): void {
  error.value = null;
  confirmDeleteId.value = id;
}

async function confirmDeleteForever(): Promise<void> {
  const id = confirmDeleteId.value;
  confirmDeleteId.value = null;
  if (!id) return;
  deletingIds.value.add(id);
  try {
    error.value = null;
    await api.permanentlyDeleteRecording(id);
    trashedRecordings.value = trashedRecordings.value.filter((rec) => rec.id !== id);
  } catch (err) {
    console.error("Failed to permanently delete recording:", err);
    error.value = err instanceof Error ? err.message : "Failed to permanently delete recording";
  } finally {
    deletingIds.value.delete(id);
  }
}

function extractFestival(title: string): string | null {
  const parts = title.split(" - ");
  if (parts.length === 3) {
    return parts[2].trim();
  }
  return null;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function relativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffHours = Math.floor(diffMs / 3_600_000);
  if (diffHours < 1) return "just now";
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// Mirrors the backend's 30-day auto-sweep window (RecorderService.autoSweepTrash).
function purgeAt(trashedAtStr: string): string {
  return new Date(new Date(trashedAtStr).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

function daysUntil(dateStr: string): string {
  const diffMs = new Date(dateStr).getTime() - Date.now();
  const diffDays = Math.ceil(diffMs / 86_400_000);
  if (diffDays <= 0) return "< 1 day";
  return `${diffDays}d`;
}
</script>

<style scoped>
.trash-view {
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
  max-width: 42ch;
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
  color: var(--ink-soft);
  border: 2px solid var(--ink-soft);
  padding: 5px 10px;
  transform: rotate(-2.5deg);
}

.stamp .blip {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--ink-soft);
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
  margin: 34px 0 16px;
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

.error-message {
  background: var(--paper-2);
  border: 2px solid var(--fluoro);
  color: var(--fluoro);
  padding: 12px;
  margin-bottom: 16px;
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.08em;
}

.bin {
  display: grid;
  gap: 14px;
}

.crate {
  background: var(--paper);
  border: 2.5px dashed var(--ink-soft);
  box-shadow: var(--sh);
  padding: 14px 16px;
  display: grid;
  gap: 10px;
}

.crate__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.crate__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--ink-soft);
  margin-bottom: 4px;
}

.crate__title {
  font-family: var(--disp);
  font-weight: 400;
  text-transform: uppercase;
  font-size: clamp(19px, 5.6vw, 27px);
  line-height: .95;
  letter-spacing: .01em;
  opacity: .85;
}

.tag {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--mono);
  font-weight: 700;
  font-size: 10px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--ink-soft);
  border: 1.5px solid var(--ink-soft);
  padding: 4px 9px;
  white-space: nowrap;
}

.tag .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-soft);
}

.crate__facts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: .06em;
  color: var(--ink-soft);
}

.crate__facts b {
  color: var(--ink);
  font-weight: 700;
}

.crate__purge {
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: .04em;
  color: var(--ink-soft);
  border-top: 1.5px dashed var(--ink-soft);
  padding-top: 9px;
}

.crate__purge b {
  color: var(--fluoro);
}

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.tbtn {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: .08em;
  text-transform: uppercase;
  border: 2px solid var(--line);
  background: var(--paper);
  padding: 7px 12px;
  cursor: pointer;
  color: var(--ink);
  text-decoration: none;
  transition: all .12s;
}

.tbtn:hover {
  box-shadow: 2px 2px 0 var(--ink);
  transform: translate(-1px, -1px);
}

.tbtn:disabled {
  opacity: .5;
  cursor: not-allowed;
  box-shadow: none;
  transform: none;
}

.tbtn--go {
  border-color: var(--violet);
  color: var(--violet);
}

.tbtn--go:hover:not(:disabled) {
  background: var(--violet);
  color: #fff;
  box-shadow: 2px 2px 0 var(--ink);
}

.tbtn--stop {
  border-color: var(--fluoro);
  color: var(--fluoro);
}

.tbtn--stop:hover:not(:disabled) {
  background: var(--fluoro);
  color: #fff;
  box-shadow: 2px 2px 0 var(--ink);
}

.empty-state {
  text-align: center;
  padding: 2rem;
  color: var(--ink-soft);
  font-style: italic;
}

@media (min-width: 768px) {
  .crate__top {
    align-items: center;
  }
}

@media (min-width: 1100px) {
  .bin {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    align-items: start;
  }
}
</style>
