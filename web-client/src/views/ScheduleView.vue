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
                placeholder="Act — Stage — Festival"
              />
            </div>

            <div class="field">
              <label><span class="num">03</span> · Quality</label>
              <div class="quality">
                <input type="radio" name="q" id="q1" value="1080p" v-model="form.quality" />
                <label for="q1">1080p</label>
                <input type="radio" name="q" id="q2" value="720p" v-model="form.quality" />
                <label for="q2">720p</label>
                <input type="radio" name="q" id="q3" value="480p" v-model="form.quality" />
                <label for="q3">480p</label>
                <input type="radio" name="q" id="q4" value="audio" v-model="form.quality" />
                <label for="q4">Audio only</label>
              </div>
            </div>

            <div class="field row2">
              <div>
                <label for="start"><span class="num">04</span> · Start</label>
                <input
                  class="input"
                  id="start"
                  type="text"
                  v-model="form.start"
                  placeholder="dd/mm hh:mm"
                />
              </div>
              <div>
                <label for="stop"><span class="num">05</span> · Stop</label>
                <input
                  class="input"
                  id="stop"
                  type="text"
                  v-model="form.stop"
                  placeholder="dd/mm hh:mm"
                />
              </div>
            </div>

            <div class="field">
              <button class="btn btn--primary" type="submit">＋ Add to lineup</button>
            </div>
          </div>
        </form>
      </div>

      <!-- QUEUE -->
      <div class="queue">
        <p class="eyebrow">On now &amp; upcoming <span class="count">{{ recordings.length }}</span></p>

        <div class="timetable">
          <article
            v-for="rec in recordings"
            :key="rec.id"
            :class="['slot', rec.status === 'recording' ? 'slot--live' : 'slot--sched']"
          >
            <div class="slot__top">
              <div>
                <div class="slot__title">{{ rec.title }}</div>
                <div class="slot__meta">{{ rec.stage || "Stage" }} · {{ rec.event || "Event" }} · {{ rec.quality || "n/a" }}</div>
              </div>
              <span v-if="rec.status === 'recording'" class="state state--live">
                <span class="blip"></span>Rec
              </span>
              <span v-else class="state state--sched">Scheduled</span>
            </div>
            <div v-if="rec.status === 'recording'" class="prog"><i></i></div>
            <div class="slot__meta mono">{{ formatTimeInfo(rec) }}</div>
            <div class="actions">
              <button v-if="rec.status === 'recording'" class="tbtn tbtn--stop">■ Stop early</button>
              <button v-else class="tbtn tbtn--go">▶ Start now</button>
              <button class="tbtn">Edit</button>
              <button v-if="rec.status === 'scheduled'" class="tbtn">Cancel</button>
            </div>
          </article>
        </div>

        <p v-if="recordings.length === 0" class="empty-queue">No scheduled or recording sessions yet.</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { api } from "../api";

interface Recording {
  id: string;
  title: string;
  status: string;
  url?: string;
  quality?: string;
  start_at?: string;
  stop_at?: string;
  stage?: string;
  event?: string;
}

defineProps<{
  selectedId: string | null;
}>();

const emit = defineEmits<{
  selectRecording: [id: string];
}>();

const recordings = ref<Recording[]>([]);

const form = reactive({
  url: "",
  title: "",
  quality: "1080p",
  start: "",
  stop: "",
});

onMounted(async () => {
  try {
    const scheduled = await api.listRecordings("scheduled");
    const recording = await api.listRecordings("recording");
    recordings.value = [...recording, ...scheduled];
  } catch (error) {
    console.error("Failed to load schedule:", error);
  }
});

function handleAddRecording(): void {
  // Form submission will be wired by next agent
  console.log("Add recording:", form);
}

function formatTimeInfo(rec: Recording): string {
  // Placeholder formatting - will be replaced with real data
  if (rec.status === "recording") {
    return "01:12:38 recorded · ends ~23:45";
  }
  return "Tonight 21:30 → 23:45 · in 2h 4m";
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

.card {
  background: var(--paper);
  border: 2.5px solid var(--line);
  box-shadow: var(--sh);
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

.row2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
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

.state .blip {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #fff;
  animation: pulse 1.3s infinite;
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
  right: 38%;
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

.empty-queue {
  text-align: center;
  color: var(--ink-soft);
  font-style: italic;
  padding: 2rem;
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
    grid-template-columns: 400px minmax(0, 1fr);
    gap: 34px;
  }

  .booking {
    position: sticky;
    top: 88px;
  }
}
</style>
