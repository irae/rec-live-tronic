<template>
  <div class="schedule-view">
    <section class="hero">
      <h1>Book<br>The Set</h1>
      <p class="lede">Point Tronic at a stream, pick a window, and it grabs the set while you sleep.</p>
    </section>

    <div class="split">
      <!-- BOOKING FORM -->
      <div class="booking">
        <form class="card" @submit.prevent="handleAddRecording">
          <div class="card__head">New Recording <small>rec.new</small></div>
          <div class="card__body">
            <div v-if="error" class="error-message">{{ error }}</div>
            <div class="field">
              <label for="url"><span class="num">01</span> · Stream URL</label>
              <input
                class="input"
                id="url"
                type="url"
                v-model="form.url"
                placeholder="https://youtube.com/watch?v=…"
              />
            </div>

            <div class="field">
              <label for="title"><span class="num">02</span> · Title</label>
              <input
                class="input"
                id="title"
                type="text"
                v-model="form.title"
                placeholder="Act - Stage - Festival"
              />
            </div>

            <div class="field">
              <label><span class="num">03</span> · Quality</label>
              <div class="quality">
                <input type="radio" name="q" id="q0" value="best" v-model="form.quality" />
                <label for="q0">best</label>
                <input type="radio" name="q" id="q1" value="1080p" v-model="form.quality" />
                <label for="q1">1080p</label>
                <input type="radio" name="q" id="q2" value="720p" v-model="form.quality" />
                <label for="q2">720p</label>
                <input type="radio" name="q" id="q3" value="480p" v-model="form.quality" />
                <label for="q3">480p</label>
              </div>
            </div>

            <div class="field">
              <label for="start"><span class="num">04</span> · Start</label>
              <input
                class="input"
                id="start"
                type="datetime-local"
                v-model="form.start"
              />
            </div>

            <div class="field">
              <label for="duration"><span class="num">05</span> · Duration <small class="hint">h:mm</small></label>
              <input
                class="input mono"
                id="duration"
                type="text"
                inputmode="numeric"
                placeholder="1:30"
                v-model="form.duration"
                @blur="handleDurationBlur"
              />
            </div>

            <div class="field">
              <label for="stop"><span class="num">06</span> · Stop</label>
              <input
                class="input"
                id="stop"
                type="datetime-local"
                v-model="form.stop"
              />
            </div>

            <div class="field">
              <button class="btn btn--primary" type="submit">＋ Add to lineup</button>
            </div>
          </div>
        </form>
      </div>

      <!-- QUEUE -->
      <div class="queue">
        <p class="eyebrow">On now &amp; upcoming <span class="count">{{ displayedRecordings.length }}</span></p>

        <div class="timetable">
          <article
            v-for="rec in displayedRecordings"
            :key="rec.id"
            :class="['slot', rec.status === 'recording' ? 'slot--live' : 'slot--sched']"
          >
            <template v-if="editingId === rec.id">
              <div class="slot__edit">
                <div class="edit-field">
                  <label>Title</label>
                  <input class="input" v-model="editForm.title" type="text" />
                </div>
                <div class="edit-field">
                  <label>Start</label>
                  <input class="input" v-model="editForm.start" type="datetime-local" :disabled="editingRecording?.status === 'recording'" />
                </div>
                <div class="edit-field">
                  <label>Stop</label>
                  <input class="input" v-model="editForm.stop" type="datetime-local" />
                </div>
                <div class="actions">
                  <button class="tbtn" @click.prevent="saveEdit(rec.id)">Save</button>
                  <button class="tbtn" @click.prevent="cancelEdit">Cancel</button>
                </div>
              </div>
            </template>
            <template v-else-if="extendingId === rec.id">
              <div class="slot__edit">
                <div class="edit-field">
                  <label>New stop time</label>
                  <input class="input" v-model="extendForm.stop" type="datetime-local" />
                </div>
                <div class="extend-quick">
                  <button class="tbtn tbtn--extend" @click.prevent="addMinutesToExtend(10)">+10 min</button>
                  <button class="tbtn tbtn--extend" @click.prevent="addMinutesToExtend(30)">+30 min</button>
                  <button class="tbtn tbtn--extend" @click.prevent="addMinutesToExtend(60)">+60 min</button>
                </div>
                <div class="actions">
                  <button class="tbtn" @click.prevent="saveExtend(rec.id)">Extend</button>
                  <button class="tbtn" @click.prevent="cancelExtend">Cancel</button>
                </div>
              </div>
            </template>
            <template v-else>
              <div class="slot__top">
                <div>
                  <div class="slot__title">{{ rec.title }}</div>
                  <div class="slot__meta">{{ rec.stage || "Stage" }} · {{ rec.quality || "n/a" }}<template v-if="rec.url"> · <a :href="rec.url" target="_blank" rel="noopener noreferrer" class="slot__watch">Watch live ↗</a></template></div>
                </div>
                <span v-if="stoppingIds.has(rec.id)" class="state state--stopping">
                  <span class="blip"></span>Stopping…
                </span>
                <span v-else-if="rec.status === 'recording'" class="state state--live">
                  <span class="blip"></span>Rec
                </span>
                <span v-else class="state state--sched">Scheduled</span>
              </div>
              <div v-if="rec.status === 'recording'" class="prog"><i :style="{ right: (100 - recordingProgressPercent(rec)) + '%' }"></i></div>
              <div class="slot__meta mono">{{ formatTimeInfo(rec) }}</div>
              <div class="actions">
                <button v-if="rec.status === 'recording' && !stoppingIds.has(rec.id)" class="tbtn tbtn--stop" @click.prevent="handleStopEarly(rec.id)">■ Stop early</button>
                <button v-if="rec.status === 'recording' && !stoppingIds.has(rec.id)" class="tbtn tbtn--extend" @click.prevent="handleExtend(rec)">⤴ Extend</button>
                <button v-else-if="rec.status === 'scheduled' && !hasStartPassed(rec)" class="tbtn tbtn--go" @click.prevent="handleStartNow(rec.id)">▶ Start now</button>
                <button v-if="rec.status === 'scheduled' || rec.status === 'recording'" class="tbtn" @click.prevent="startEdit(rec)">Edit</button>
                <button v-if="rec.status === 'scheduled'" class="tbtn" @click.prevent="handleCancel(rec.id)">Cancel</button>
              </div>
            </template>
          </article>
        </div>

        <p v-if="displayedRecordings.length === 0" class="empty-queue">No scheduled or recording sessions yet.</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onMounted, onUnmounted, computed } from "vue";
import { api } from "../api";

interface Recording {
  id: string;
  title: string;
  status: string;
  url: string;
  quality: string;
  startAt: string;
  stopAt: string;
  stage: string | null;
  cookieId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const recordings = ref<Recording[]>([]);
const error = ref<string | null>(null);
const editingId = ref<string | null>(null);
const extendingId = ref<string | null>(null);
const stoppingIds = ref<Set<string>>(new Set());
const editForm = reactive({
  title: "",
  start: "",
  stop: "",
});
const extendForm = reactive({
  stop: "",
});

const form = reactive({
  url: "",
  title: "",
  quality: "best",
  start: "",
  duration: "",
  stop: "",
});

// Start is the anchor field. Duration and Stop stay in sync with each other
// (Stop = Start + Duration) without ever rewriting Start.
let syncingTime = false;

function parseDurationMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hm = trimmed.match(/^(\d+):([0-5]?\d)$/);
  if (hm) {
    return parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
  }
  const asMinutes = Number(trimmed);
  return Number.isFinite(asMinutes) && asMinutes >= 0 ? Math.round(asMinutes) : null;
}

function formatDurationMinutes(totalMinutes: number): string {
  const clamped = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(clamped / 60);
  const mins = clamped % 60;
  return `${hours}:${String(mins).padStart(2, "0")}`;
}

// Let the user type freely (e.g. "90") -- only parse/reformat (to "H:MM")
// and recompute Stop once they leave the field, not on every keystroke.
function handleDurationBlur(): void {
  if (syncingTime || !form.start) return;
  const minutes = parseDurationMinutes(form.duration);
  if (minutes === null) return;
  syncingTime = true;
  form.duration = formatDurationMinutes(minutes);
  const stopDate = new Date(new Date(form.start).getTime() + minutes * 60_000);
  form.stop = toLocalDatetimeInputValue(stopDate.toISOString());
  syncingTime = false;
}

watch(
  () => form.stop,
  (value) => {
    if (syncingTime || !form.start || !value) return;
    const diffMinutes = (new Date(value).getTime() - new Date(form.start).getTime()) / 60_000;
    syncingTime = true;
    form.duration = diffMinutes >= 0 ? formatDurationMinutes(diffMinutes) : "";
    syncingTime = false;
  }
);

watch(
  () => form.start,
  (value, oldValue) => {
    if (syncingTime || !value || !oldValue) return;
    const minutes = parseDurationMinutes(form.duration);
    if (minutes === null) return;
    syncingTime = true;
    const stopDate = new Date(new Date(value).getTime() + minutes * 60_000);
    form.stop = toLocalDatetimeInputValue(stopDate.toISOString());
    syncingTime = false;
  }
);

const displayedRecordings = computed(() => {
  return recordings.value.filter(
    (rec) => rec.status === "scheduled" || rec.status === "recording"
  );
});

const editingRecording = computed(() => {
  return recordings.value.find((rec) => rec.id === editingId.value);
});

async function fetchRecordings(): Promise<void> {
  try {
    error.value = null;
    const all = await api.listRecordings();
    recordings.value = all;
    for (const id of stoppingIds.value) {
      const rec = all.find((r) => r.id === id);
      if (!rec || rec.status !== "recording") {
        stoppingIds.value.delete(id);
      }
    }
  } catch (err) {
    console.error("Failed to load schedule:", err);
    error.value =
      err instanceof Error ? err.message : "Failed to load recordings";
  }
}

onMounted(async () => {
  await fetchRecordings();
  const pollInterval = setInterval(fetchRecordings, 60_000);

  onUnmounted(() => {
    clearInterval(pollInterval);
  });
});

async function handleAddRecording(): Promise<void> {
  try {
    error.value = null;
    if (!form.url || !form.title) {
      error.value = "Stream URL and title are required";
      return;
    }

    // Reasonable defaults instead of demanding every field: no start means
    // now, no stop/duration means 60 minutes from start.
    const startDate = form.start ? new Date(form.start) : new Date();
    const stopDate = form.stop
      ? new Date(form.stop)
      : new Date(startDate.getTime() + (parseDurationMinutes(form.duration) ?? 60) * 60_000);

    const newRecording = await api.createRecording({
      url: form.url,
      title: form.title,
      quality: form.quality,
      start_at: startDate.toISOString(),
      stop_at: stopDate.toISOString(),
    });

    recordings.value.unshift(newRecording as unknown as Recording);
    form.url = "";
    form.title = "";
    form.quality = "best";
    form.start = "";
    form.duration = "";
    form.stop = "";
  } catch (err) {
    console.error("Failed to create recording:", err);
    error.value =
      err instanceof Error ? err.message : "Failed to create recording";
  }
}

async function handleCancel(id: string): Promise<void> {
  try {
    error.value = null;
    await api.cancelRecording(id);
    recordings.value = recordings.value.filter((rec) => rec.id !== id);
  } catch (err) {
    console.error("Failed to cancel recording:", err);
    error.value =
      err instanceof Error ? err.message : "Failed to cancel recording";
  }
}

async function handleStartNow(id: string): Promise<void> {
  try {
    error.value = null;
    const result = await api.patchRecording(id, {
      start_at: new Date().toISOString(),
    });
    const idx = recordings.value.findIndex((rec) => rec.id === id);
    if (idx >= 0) {
      recordings.value[idx] = result.recording as unknown as Recording;
    }
  } catch (err) {
    console.error("Failed to start recording:", err);
    error.value =
      err instanceof Error ? err.message : "Failed to start recording";
  }
}

async function handleStopEarly(id: string): Promise<void> {
  stoppingIds.value.add(id);
  try {
    error.value = null;
    const result = await api.patchRecording(id, {
      stop_at: new Date().toISOString(),
    });
    const idx = recordings.value.findIndex((rec) => rec.id === id);
    if (idx >= 0) {
      recordings.value[idx] = result.recording as unknown as Recording;
    }
  } catch (err) {
    console.error("Failed to stop recording:", err);
    error.value =
      err instanceof Error ? err.message : "Failed to stop recording";
    stoppingIds.value.delete(id);
  }
}

function handleExtend(rec: Recording): void {
  extendingId.value = rec.id;
  extendForm.stop = toLocalDatetimeInputValue(rec.stopAt);
}

function addMinutesToExtend(minutes: number): void {
  if (!extendForm.stop) return;
  const stopDate = new Date(extendForm.stop);
  const newStop = new Date(stopDate.getTime() + minutes * 60_000);
  extendForm.stop = toLocalDatetimeInputValue(newStop.toISOString());
}

async function saveExtend(id: string): Promise<void> {
  try {
    error.value = null;
    const stopDate = new Date(extendForm.stop);
    const result = await api.patchRecording(id, {
      stop_at: stopDate.toISOString(),
    });
    const idx = recordings.value.findIndex((rec) => rec.id === id);
    if (idx >= 0) {
      recordings.value[idx] = result.recording as unknown as Recording;
    }
    extendingId.value = null;
  } catch (err) {
    console.error("Failed to extend recording:", err);
    error.value =
      err instanceof Error ? err.message : "Failed to extend recording";
  }
}

function cancelExtend(): void {
  extendingId.value = null;
}

function toLocalDatetimeInputValue(isoString: string): string {
  const date = new Date(isoString);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function startEdit(rec: Recording): void {
  editingId.value = rec.id;
  editForm.title = rec.title;
  editForm.start = toLocalDatetimeInputValue(rec.startAt);
  editForm.stop = toLocalDatetimeInputValue(rec.stopAt);
}

async function saveEdit(id: string): Promise<void> {
  try {
    error.value = null;
    const startDate = new Date(editForm.start);
    const stopDate = new Date(editForm.stop);

    const payload: any = {
      title: editForm.title,
      stop_at: stopDate.toISOString(),
    };
    if (editingRecording.value?.status !== 'recording') {
      payload.start_at = startDate.toISOString();
    }

    await api.patchRecording(id, payload);

    const idx = recordings.value.findIndex((rec) => rec.id === id);
    if (idx >= 0) {
      recordings.value[idx].title = editForm.title;
      if (editingRecording.value?.status !== 'recording') {
        recordings.value[idx].startAt = startDate.toISOString();
      }
      recordings.value[idx].stopAt = stopDate.toISOString();
    }

    editingId.value = null;
  } catch (err) {
    console.error("Failed to update recording:", err);
    error.value =
      err instanceof Error ? err.message : "Failed to update recording";
  }
}

function cancelEdit(): void {
  editingId.value = null;
}

function hasStartPassed(rec: Recording): boolean {
  return new Date(rec.startAt).getTime() <= Date.now();
}

function recordingProgressPercent(rec: Recording): number {
  const start = new Date(rec.startAt).getTime();
  const stop = new Date(rec.stopAt).getTime();
  const now = Date.now();
  if (stop <= start) return 0;
  return Math.min(100, Math.max(0, ((now - start) / (stop - start)) * 100));
}

function formatTimeInfo(rec: Recording): string {
  const start = new Date(rec.startAt);
  const stop = new Date(rec.stopAt);
  const now = new Date();

  if (rec.status === "recording") {
    const elapsed = Math.floor((now.getTime() - start.getTime()) / 1000);
    const elapsedHours = Math.floor(elapsed / 3600);
    const elapsedMins = Math.floor((elapsed % 3600) / 60);
    const elapsedSecs = Math.floor(elapsed % 60);
    const endTime = stop.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    return `${elapsedHours}:${String(elapsedMins).padStart(2, "0")}:${String(elapsedSecs).padStart(2, "0")} recorded · ends ~${endTime}`;
  }

  const timeUntil = Math.floor((start.getTime() - now.getTime()) / 1000);
  if (timeUntil < 0) {
    return "Starting soon...";
  }
  const hoursUntil = Math.floor(timeUntil / 3600);
  const minsUntil = Math.floor((timeUntil % 3600) / 60);
  const startTime = start.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const endTime = stop.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${startTime} → ${endTime} · in ${hoursUntil}h ${minsUntil}m`;
}
</script>

<style scoped>
.schedule-view {
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

.split {
  display: grid;
  gap: 26px;
  align-items: start;
}

.booking {
  min-width: 0;
}

.card {
  background: var(--paper);
  border: 2.5px solid var(--line);
  box-shadow: var(--sh);
  min-width: 0;
}

.card__head {
  background: var(--ink);
  color: var(--paper);
  font-family: var(--disp);
  text-transform: uppercase;
  letter-spacing: .03em;
  font-size: 22px;
  padding: 12px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.card__head small {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: .16em;
  color: var(--fluoro);
}

.card__body {
  padding: 18px;
}

.field {
  margin-bottom: 16px;
}

.field:last-child {
  margin-bottom: 0;
}

.field > label {
  display: block;
  font-family: var(--mono);
  font-weight: 700;
  font-size: 10.5px;
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--ink-soft);
  margin-bottom: 6px;
}

.field .num {
  color: var(--fluoro);
}

.field .hint {
  font-family: var(--mono);
  font-weight: 400;
  font-size: 9.5px;
  letter-spacing: .1em;
  text-transform: none;
  color: var(--ink-soft);
  opacity: .7;
}

.input {
  width: 100%;
  font-family: var(--ui);
  font-size: 15px;
  color: var(--ink);
  background: var(--paper-2);
  border: 2px solid var(--line);
  border-radius: 0;
  padding: 11px 12px;
  appearance: none;
}

.input::placeholder {
  color: #8b8598;
}

.input:focus,
.input:focus-visible {
  outline: none;
  background: var(--paper);
  box-shadow: 3px 3px 0 var(--fluoro);
}

.input:disabled {
  background: var(--paper-2);
  color: var(--ink-soft);
  opacity: 0.6;
  cursor: not-allowed;
}

.quality {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.quality input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.quality label {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: .08em;
  padding: 8px 12px;
  border: 2px solid var(--line);
  cursor: pointer;
  transition: all .12s;
}

.quality input:checked + label {
  background: var(--violet);
  color: var(--paper);
  border-color: var(--violet);
}

.quality label:hover {
  box-shadow: 2px 2px 0 var(--ink);
}

.btn {
  font-family: var(--ui);
  font-weight: 700;
  font-size: 13.5px;
  text-transform: uppercase;
  letter-spacing: .08em;
  border: 2.5px solid var(--line);
  border-radius: 0;
  padding: 12px 18px;
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--paper);
  color: var(--ink);
  transition: transform .12s ease, box-shadow .12s ease, background .12s;
  width: 100%;
}

.btn:hover {
  transform: translate(-2px, -2px);
  box-shadow: 4px 4px 0 var(--ink);
}

.btn:active {
  transform: translate(0, 0);
  box-shadow: 1px 1px 0 var(--ink);
}

.btn--primary {
  background: var(--violet);
  color: #fff;
  border-color: var(--violet);
}

.btn--primary:hover {
  box-shadow: 4px 4px 0 var(--ink);
  background: var(--violet-d);
}

.queue {
  min-width: 0;
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
  margin: 0 0 16px 0;
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

.timetable {
  display: grid;
  gap: 12px;
}

.slot {
  background: var(--paper);
  border: 2.5px solid var(--line);
  box-shadow: var(--sh);
  padding: 13px 15px;
  display: grid;
  gap: 10px;
  border-left-width: 8px;
}

.slot--live {
  border-left-color: var(--fluoro);
}

.slot--sched {
  border-left-color: var(--violet);
}

.slot__top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.slot__title {
  font-family: var(--disp);
  text-transform: uppercase;
  font-size: clamp(18px, 5.5vw, 24px);
  line-height: .95;
  letter-spacing: .01em;
}

.slot__meta {
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--ink-soft);
}

.slot__watch {
  color: var(--violet);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.slot__watch:hover {
  color: var(--fluoro);
}

.state {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 10px;
  letter-spacing: .16em;
  text-transform: uppercase;
  padding: 4px 9px;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.state--live {
  background: var(--fluoro);
  color: #fff;
}

.state--sched {
  border: 2px solid var(--violet);
  color: var(--violet);
}

.state--stopping {
  border: 2px solid var(--fluoro);
  background: var(--paper-2);
  color: var(--fluoro);
}

.state .blip {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #fff;
  animation: pulse 1.3s infinite;
}

.state--stopping .blip {
  background: var(--fluoro);
}

.prog {
  height: 8px;
  border: 2px solid var(--line);
  background: var(--paper-2);
  position: relative;
  overflow: hidden;
}

.prog > i {
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(45deg, var(--fluoro) 0 8px, #ff6a53 8px 16px);
  animation: slide 1s linear infinite;
}

.mono {
  font-family: var(--mono);
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

.tbtn--extend {
  border-color: var(--violet);
  color: var(--violet);
}

.tbtn--extend:hover {
  background: var(--violet);
  color: #fff;
  box-shadow: 2px 2px 0 var(--ink);
}

.extend-quick {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.empty-queue {
  text-align: center;
  color: var(--ink-soft);
  font-style: italic;
  padding: 2rem;
}

.error-message {
  background: var(--paper-2);
  border: 2px solid var(--fluoro);
  color: var(--fluoro);
  padding: 12px;
  margin-bottom: 12px;
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.08em;
}

.slot__edit {
  display: grid;
  gap: 12px;
  padding: 8px 0;
}

.edit-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.edit-field label {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 10px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--ink-soft);
}

.edit-field .input {
  font-size: 13px;
  padding: 8px 10px;
}

@keyframes pulse {
  0%,100% { opacity:1; transform:scale(1); }
  50% { opacity:.35; transform:scale(.7); }
}

@keyframes slide {
  from { background-position: 0 0; }
  to { background-position: 16px 0; }
}

@media (min-width: 900px) {
  .split {
    grid-template-columns: 420px minmax(0, 1fr);
    gap: 34px;
  }

  .booking {
    position: sticky;
    top: 88px;
  }
}
</style>
