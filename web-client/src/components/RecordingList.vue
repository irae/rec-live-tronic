<template>
  <div class="lineup">
    <template v-if="recordings.length > 0">
      <a
        v-for="recording in recordings"
        :key="recording.id"
        class="stub"
        href="#"
        @click.prevent="$emit('select', recording.id)"
      >
        <div class="stub-index">
          <span class="stg">{{ recording.stage || "Stage" }}<small>{{ stageSubtext }}</small></span>
        </div>
        <div class="stub-body">
          <div class="stub-meta">
            <span v-if="extractFestival(recording.title)">{{ extractFestival(recording.title) }}</span>
            <span v-if="extractFestival(recording.title)">·</span>
            <span>{{ formatDate(recording.startAt) }}</span>
          </div>
          <div class="stub-title">{{ recording.title }}</div>
          <div class="stub-foot">
            <span class="dur">{{ computeDuration(recording.startAt, recording.stopAt) }}</span>
            <span class="chip" :class="{ 'chip--hd': isHd(recording.quality) }">{{ recording.quality || "n/a" }}</span>
            <span class="arrow">→</span>
          </div>
        </div>
      </a>
    </template>
    <div v-else class="empty-state">
      <p>{{ emptyMessage }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

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
  version: number;
  createdAt: string;
  updatedAt: string;
}

const props = withDefaults(
  defineProps<{
    recordings: Recording[];
    emptyMessage?: string;
    stageSubtext?: string;
  }>(),
  {
    emptyMessage: "No recordings yet.",
    stageSubtext: "STAGE",
  }
);

defineEmits<{
  select: [id: string];
}>();

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

function computeDuration(startAt: string, stopAt: string): string {
  const start = new Date(startAt).getTime();
  const stop = new Date(stopAt).getTime();
  const diffMs = stop - start;
  if (diffMs <= 0) return "—";

  const diffSec = Math.floor(diffMs / 1000);
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const seconds = Math.floor(diffSec % 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function isHd(quality: string): boolean {
  return quality.includes("1080");
}
</script>

<style scoped>
.lineup { display: grid; gap: 14px; }

.stub {
  position: relative;
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr);
  background: var(--paper);
  border: 2.5px solid var(--line);
  box-shadow: var(--sh);
  text-decoration: none; color: inherit;
  transition: transform .13s ease, box-shadow .13s ease;
  overflow: hidden;
}

.stub:hover { transform: translate(-3px,-3px); box-shadow: var(--sh-lift); }
.stub:hover .stub-index { background: var(--fluoro); color: var(--paper); }

.stub-index {
  background: var(--ink); color: var(--paper);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px; padding: 10px 4px;
  font-family: var(--disp); text-transform: uppercase;
  transition: background .13s;
  position: relative;
}

.stub-index .stg { font-size: 20px; line-height: .85; letter-spacing: .02em; }
.stub-index .stg small { display:block; font-family: var(--mono); font-size: 8px; letter-spacing:.12em; opacity:.8; margin-top:4px; }

.stub-index::after {
  content:""; position: absolute; top:0; right:-1px; bottom:0; width: 14px;
  background:
    radial-gradient(circle at right, var(--paper) var(--stub-r), transparent calc(var(--stub-r) + 0.5px));
  background-size: 14px 18px; background-repeat: repeat-y;
}

.stub-body { padding: 13px 15px 13px 16px; min-width: 0; }

.stub-meta {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em;
  text-transform: uppercase; color: var(--ink-soft); margin-bottom: 4px;
}

.stub-title {
  font-family: var(--disp); font-weight: 400; text-transform: uppercase;
  font-size: clamp(20px, 6.2vw, 30px); line-height: .95; letter-spacing: .01em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.stub-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  margin-top: 9px;
}

.dur {
  font-family: var(--mono); font-weight: 700; font-size: 14px;
  letter-spacing: .05em; color: var(--ink);
}

.dur::before { content:"⏱ "; color: var(--fluoro); font-size: 12px; }

.chip {
  font-family: var(--mono); font-size: 9.5px; font-weight:700; letter-spacing: .14em;
  text-transform: uppercase; padding: 3px 8px; border: 1.5px solid var(--line);
}

.chip--hd { color: var(--violet); border-color: var(--violet); }

.arrow { font-family: var(--disp); font-size: 22px; color: var(--fluoro); line-height:1; }

.empty-state {
  text-align: center;
  padding: 2rem;
  color: var(--ink-soft);
  font-style: italic;
}

@media (min-width: 768px) {
  .stub { grid-template-columns: 92px minmax(0, 1fr); }
  .stub-index .stg { font-size: 26px; }
}

@media (min-width: 1100px) {
  .lineup { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
}
</style>
