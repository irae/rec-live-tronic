<template>
  <div class="trash-view">
    <section class="hero">
      <span class="stamp"><span class="blip"></span>on the way out</span>
      <h1>Off The<br>Bill</h1>
      <p class="lede">Pulled sets, held before the wipe. Bring one back or clear it for good — nothing here is final yet.</p>
    </section>

    <p class="eyebrow">Trashed sets <span class="count">{{ trashedRecordings.length }}</span></p>

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
          <span class="fact">Size <b>{{ formatSize(rec.fileSizeBytes) }}</b></span>
        </div>

        <div class="crate__purge">
          Auto-purges in <b>{{ daysUntil(rec.purgeAt) }}</b> — permanent delete cannot be undone after that
        </div>

        <div class="actions">
          <button class="tbtn tbtn--go" @click.prevent>↺ Restore</button>
          <button class="tbtn tbtn--stop" @click.prevent>🗑 Delete forever</button>
        </div>
      </article>
    </div>
    <div v-else class="empty-state">
      <p>Nothing in the bin. Trashed sets show up here before they're gone for good.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
// Static stub data — no backend support for trash yet. Fields mirror the real
// Recording shape (see api.ts) plus placeholder trash-only fields
// (trashedAt/purgeAt/fileSizeBytes) that a later phase will replace with the
// real thing. Restore / Delete forever are visual only, not wired.
interface TrashedRecording {
  id: string;
  url: string;
  title: string;
  stage: string | null;
  cookieId: string | null;
  quality: string;
  startAt: string;
  stopAt: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  trashedAt: string;
  purgeAt: string;
  fileSizeBytes: number;
}

const trashedRecordings: TrashedRecording[] = [
  {
    id: "rec-a1b2c3",
    url: "https://www.youtube.com/watch?v=stub001",
    title: "Nightcrawler - Main Stage - Voidfest",
    stage: "Main Stage",
    cookieId: null,
    quality: "1080p",
    startAt: "2026-07-18T20:00:00Z",
    stopAt: "2026-07-18T22:15:00Z",
    status: "recorded",
    version: 3,
    createdAt: "2026-07-18T19:50:00Z",
    updatedAt: "2026-07-21T09:12:00Z",
    trashedAt: "2026-07-21T09:12:00Z",
    purgeAt: "2026-08-04T09:12:00Z",
    fileSizeBytes: 4831838208,
  },
  {
    id: "rec-d4e5f6",
    url: "https://www.youtube.com/watch?v=stub002",
    title: "Low Signal - B Stage - Voidfest",
    stage: "B Stage",
    cookieId: null,
    quality: "720p",
    startAt: "2026-07-19T18:30:00Z",
    stopAt: "2026-07-19T19:45:00Z",
    status: "recorded",
    version: 1,
    createdAt: "2026-07-19T18:20:00Z",
    updatedAt: "2026-07-22T14:03:00Z",
    trashedAt: "2026-07-22T14:03:00Z",
    purgeAt: "2026-08-05T14:03:00Z",
    fileSizeBytes: 1042503680,
  },
  {
    id: "rec-g7h8i9",
    url: "https://www.youtube.com/watch?v=stub003",
    title: "Test capture — bad cookie",
    stage: null,
    cookieId: "cookie-primary",
    quality: "480p",
    startAt: "2026-07-20T10:00:00Z",
    stopAt: "2026-07-20T10:02:00Z",
    status: "failed",
    version: 1,
    createdAt: "2026-07-20T09:58:00Z",
    updatedAt: "2026-07-22T22:30:00Z",
    trashedAt: "2026-07-22T22:30:00Z",
    purgeAt: "2026-08-05T22:30:00Z",
    fileSizeBytes: 18874368,
  },
  {
    id: "rec-j1k2l3",
    url: "https://www.youtube.com/watch?v=stub004",
    title: "Static Hymn - Main Stage - Voidfest",
    stage: "Main Stage",
    cookieId: null,
    quality: "1080p",
    startAt: "2026-07-15T21:00:00Z",
    stopAt: "2026-07-15T23:30:00Z",
    status: "recorded",
    version: 2,
    createdAt: "2026-07-15T20:50:00Z",
    updatedAt: "2026-07-16T08:00:00Z",
    trashedAt: "2026-07-16T08:00:00Z",
    purgeAt: "2026-07-30T08:00:00Z",
    fileSizeBytes: 6710886400,
  },
];

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

function daysUntil(dateStr: string): string {
  const diffMs = new Date(dateStr).getTime() - Date.now();
  const diffDays = Math.ceil(diffMs / 86_400_000);
  if (diffDays <= 0) return "< 1 day";
  return `${diffDays}d`;
}

function formatSize(bytes: number): string {
  const gb = bytes / 1_073_741_824;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1_048_576;
  return `${mb.toFixed(0)} MB`;
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

.tbtn--go {
  border-color: var(--violet);
  color: var(--violet);
}

.tbtn--go:hover {
  background: var(--violet);
  color: #fff;
  box-shadow: 2px 2px 0 var(--ink);
}

.tbtn--stop {
  border-color: var(--fluoro);
  color: var(--fluoro);
}

.tbtn--stop:hover {
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
