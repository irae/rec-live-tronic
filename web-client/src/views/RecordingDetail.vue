<template>
  <div class="recording-detail">
    <a class="back" href="#" @click.prevent="goBack">Back to lineup</a>

    <div v-if="recording" class="detail-grid" :class="{ 'detail-grid--cut-open': cutOpen }">
      <!-- MEDIA -->
      <div class="col-media">
        <div v-if="recording.status === 'recorded'" class="orig" :class="{ 'orig--collapsed': playerCollapsed }">
          <div v-if="playerCollapsed" class="orig__bar" @click="playerCollapsed = false">
            <span class="l"><span class="caret">▸</span> Original · {{ recording.title }} <b>— still open, paused</b></span>
            <span class="toggle">Show</span>
          </div>
          <div class="orig__body">
            <div class="player">
              <div class="frame">
                <span>{{ extractFestival(recording.title) ? extractFestival(recording.title) : recording.stage || "Stage" }}</span>
                <span class="rec"><span class="blip"></span>archived</span>
              </div>
              <video ref="videoEl" :src="streamUrl" controls class="video-player"></video>
            </div>
          </div>
        </div>
        <div v-else class="player player--placeholder">
          <div class="frame">
            <span>{{ recording.stage || "Stage" }}</span>
            <span class="rec"><span class="blip"></span>archived</span>
          </div>
          <div class="not-ready">
            <p>Recording not ready to play yet.</p>
            <p class="status">Status: <b>{{ formatStatus(recording.status) }}</b></p>
          </div>
        </div>

        <h1 class="detail-title">{{ recording.title }}<br></h1>

        <div class="detail-sub">
          <span class="m">Duration <b>{{ computeDuration(recording.startAt, recording.stopAt) }}</b></span>
          <span class="m">Quality <b>{{ recording.quality || "n/a" }}</b></span>
          <span class="m">Recorded <b>{{ formatDate(recording.startAt) }}</b></span>
        </div>

        <div v-if="recording.cutFromId && sourceRecording" class="lineage">
          <span class="ic">✂</span>
          <span class="txt">Cut from <b>{{ sourceRecording.title }}</b>
            <template v-if="lineageOffsets"> · {{ lineageOffsets }}</template>
            &nbsp;
            <router-link :to="{ name: 'detail', params: { id: recording.cutFromId } }">See original ↗</router-link>
          </span>
        </div>

        <div v-else-if="derivedRecordings.length > 0" class="recut">
          ↻ <b>Re-cut into {{ derivedRecordings.length }} recording{{ derivedRecordings.length === 1 ? "" : "s" }}</b>
          —
          <template v-for="(cut, idx) in derivedRecordings" :key="cut.id">
            <router-link :to="{ name: 'detail', params: { id: cut.id } }">{{ cut.title }} ↗</router-link><span v-if="idx < derivedRecordings.length - 1">, </span>
          </template>
        </div>
      </div>

      <!-- INFO / ACTIONS -->
      <div class="col-info">
        <p class="eyebrow">Stream URL</p>
        <div class="urlbar">
          <code id="streamurl">{{ friendlyStreamUrl }}</code>
          <button class="copy" @click="copyUrl" :class="{ done: copyDone }">{{ copyDone ? "Copied ✓" : "Copy" }}</button>
        </div>
        <div class="vlc-line">
          <a v-if="isIos || isMac" class="vlc" :href="vlcUrl">Open in VLC ↗</a>
          <span v-if="isIos || isMac" class="vlc-note"> — optional, best-effort, may not always work without VLC's URL handler registered</span>
        </div>

        <div v-if="recording.status === 'recorded' && editing" class="edit-panel">
          <p class="eyebrow">Edit details</p>
          <div class="edit-field">
            <label for="edit-title">Title</label>
            <input id="edit-title" class="input" type="text" v-model="editForm.title" />
          </div>
          <div class="edit-field">
            <label for="edit-artist">Artist</label>
            <input id="edit-artist" class="input" type="text" v-model="editForm.artist" placeholder="optional label" />
          </div>
          <div class="edit-field">
            <label for="edit-venue">Venue</label>
            <input id="edit-venue" class="input" type="text" v-model="editForm.venue" placeholder="optional label" />
          </div>
          <div class="edit-field">
            <label for="edit-event">Event</label>
            <input id="edit-event" class="input" type="text" v-model="editForm.event" placeholder="optional label" />
          </div>
          <div class="edit-field">
            <label for="edit-stage">Stage</label>
            <input id="edit-stage" class="input" type="text" v-model="editForm.stage" placeholder="optional label" />
          </div>
          <p v-if="editError" class="edit-error">{{ editError }}</p>
          <div class="edit-buttons">
            <button class="tbtn tbtn--save" @click="saveEdit" :disabled="editSaving || !editForm.title.trim()">{{ editSaving ? "Saving…" : "Save" }}</button>
            <button class="tbtn" @click="cancelEdit" :disabled="editSaving">Cancel</button>
          </div>
        </div>

        <template v-else>
          <button v-if="recording.status === 'recorded'" class="btn btn--edit" @click="startEdit">✎ Edit details</button>

          <CutConsole
            v-if="recording.status === 'recorded' && recordingId"
            :recording-id="recordingId"
            :recording="recording"
            :get-current-time="getCurrentTime"
            @phase-change="onCutPhaseChange"
            @kept="onCutKept"
          />

          <a v-if="recording.status === 'recorded'" class="btn btn--download" :href="downloadUrl">⬇ Download .mp4</a>

          <div class="trash-row">
            <button class="btn--trash" @click="handleDelete" title="Moves this recording to Trash. It stays there for 30 days — restore it any time, or purge it for good from the Trash view.">🗑 Delete</button>
            <span class="trash-note">Moves to Trash · restorable for 30 days</span>
          </div>
          <p v-if="deleteError" class="danger-error">{{ deleteError }}</p>
        </template>
      </div>
    </div>

    <div v-else class="loading">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, type Recording as ApiRecording } from "../api";
import { useToast } from "../composables/useToast";
import CutConsole from "../components/CutConsole.vue";
import { formatOffsetSeconds } from "../lib/cut-offsets";
import { fileUrl } from "../lib/file-url";
import { isIosDevice, isMacDevice, vlcUrlFor } from "../lib/vlc";
import { copyText } from "../lib/copy";

const { toast } = useToast();

interface Recording {
  id: string;
  url: string;
  title: string;
  status: string;
  stage: string | null;
  artist: string | null;
  venue: string | null;
  event: string | null;
  quality: string;
  startAt: string;
  stopAt: string;
  cookieId: string | null;
  cutFromId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const route = useRoute();
const router = useRouter();

const recordingId = computed(() => {
  const id = route.params.id;
  return typeof id === "string" ? id : null;
});

const recording = ref<Recording | null>(null);
const copyDone = ref(false);
const deleteError = ref<string | null>(null);
const editing = ref(false);
const editSaving = ref(false);
const editError = ref<string | null>(null);
const editForm = ref({ title: "", stage: "", artist: "", venue: "", event: "" });
const playerCollapsed = ref(false);
const sourceRecording = ref<ApiRecording | null>(null);
const derivedRecordings = ref<ApiRecording[]>([]);

const lineageOffsets = computed(() => {
  if (!recording.value || !sourceRecording.value) return null;
  const sourceStart = new Date(sourceRecording.value.startAt).getTime();
  const startOffset = (new Date(recording.value.startAt).getTime() - sourceStart) / 1000;
  const endOffset = (new Date(recording.value.stopAt).getTime() - sourceStart) / 1000;
  if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset)) return null;
  return `${formatOffsetSeconds(startOffset)} → ${formatOffsetSeconds(endOffset)}`;
});

function getCurrentTime(): number | null {
  return videoEl.value ? videoEl.value.currentTime : null;
}

const cutPhase = ref<"mark" | "processing" | "preview" | "closed">("closed");
const cutOpen = computed(() => cutPhase.value !== "closed");

function onCutPhaseChange(phase: "mark" | "processing" | "preview" | "closed"): void {
  cutPhase.value = phase;
  playerCollapsed.value = phase === "preview";
}

// Every successful Keep renames-and-trashes the source (see spec.md), so
// staying on this page would show a now-stale view. Jump straight to the
// one new recording, or to the Archive when a split kept several.
function onCutKept(kept: ApiRecording[]): void {
  toast(kept.length === 1 ? "Kept 1 cut" : `Kept ${kept.length} cuts`);
  if (kept.length === 1 && kept[0]) {
    router.push({ name: "detail", params: { id: kept[0].id } });
  } else {
    router.push({ name: "archive" });
  }
}

// Plain (no friendly-filename segment) URL for the embedded <video> player --
// the friendly form only matters for VLC/copy-URL/external players, which key
// off the URL path rather than the Content-Disposition header.
const streamUrl = computed(() => {
  if (!recordingId.value) return "";
  return `${window.location.origin}/recordings/${recordingId.value}/file`;
});

const friendlyStreamUrl = computed(() => {
  if (!recordingId.value || !recording.value) return "";
  return fileUrl(recordingId.value, recording.value.title);
});

const downloadUrl = computed(() => {
  if (!recordingId.value || !recording.value) return "";
  return fileUrl(recordingId.value, recording.value.title, { download: true });
});

const videoEl = ref<HTMLVideoElement | null>(null);

const isIos = computed(() => isIosDevice());
const isMac = computed(() => isMacDevice());
const vlcUrl = computed(() => vlcUrlFor(friendlyStreamUrl.value));

watch(
  () => route.params.id,
  async (id) => {
    recording.value = null;
    editing.value = false;
    editError.value = null;
    playerCollapsed.value = false;
    cutPhase.value = "closed";
    sourceRecording.value = null;
    derivedRecordings.value = [];
    if (typeof id !== "string") return;
    try {
      const loaded = await api.getRecording(id);
      if (route.params.id !== id) return;
      recording.value = loaded;
      document.title = `${recording.value.title} - RecTronic`;
      if (recording.value.cutFromId) {
        const cutFromId = recording.value.cutFromId;
        api.getRecording(cutFromId)
          .then((source) => { if (route.params.id === id) sourceRecording.value = source; })
          .catch((error) => console.error("Failed to load source recording:", error));
      } else {
        api.listCutFrom(id)
          .then((cuts) => { if (route.params.id === id) derivedRecordings.value = cuts; })
          .catch((error) => console.error("Failed to load derived recordings:", error));
      }
    } catch (error) {
      console.error("Failed to load recording:", error);
    }
  },
  { immediate: true },
);

function goBack(): void {
  router.push({ name: "archive" });
}

function showCopied(): void {
  copyDone.value = true;
  setTimeout(() => {
    copyDone.value = false;
  }, 1600);
}

async function copyUrl(): Promise<void> {
  if (await copyText(friendlyStreamUrl.value)) showCopied();
}

async function handleDelete(): Promise<void> {
  if (!recordingId.value) return;
  deleteError.value = null;
  try {
    await api.deleteRecordingFile(recordingId.value);
    toast("Moved to Trash");
    router.push({ name: "archive" });
  } catch (error) {
    console.error("Failed to delete recording:", error);
    deleteError.value = error instanceof Error ? error.message : "Failed to delete recording";
  }
}

function startEdit(): void {
  if (!recording.value) return;
  editForm.value = {
    title: recording.value.title,
    stage: recording.value.stage ?? "",
    artist: recording.value.artist ?? "",
    venue: recording.value.venue ?? "",
    event: recording.value.event ?? "",
  };
  editError.value = null;
  editing.value = true;
}

function cancelEdit(): void {
  editing.value = false;
  editError.value = null;
}

async function saveEdit(): Promise<void> {
  if (!recordingId.value || !recording.value) return;
  const title = editForm.value.title.trim();
  if (!title) {
    editError.value = "Title is required";
    return;
  }
  editSaving.value = true;
  editError.value = null;
  try {
    const result = await api.patchRecording(recordingId.value, {
      title,
      stage: editForm.value.stage.trim(),
      artist: editForm.value.artist.trim(),
      venue: editForm.value.venue.trim(),
      event: editForm.value.event.trim(),
    });
    recording.value = result.recording as unknown as Recording;
    document.title = `${recording.value.title} - RecTronic`;
    editing.value = false;
    toast("Recording updated");
  } catch (error) {
    console.error("Failed to save recording edits:", error);
    editError.value = error instanceof Error ? error.message : "Failed to save changes";
  } finally {
    editSaving.value = false;
  }
}

function extractFestival(title: string): string | null {
  const parts = title.split(" - ");
  if (parts.length === 3) {
    return parts[2].trim();
  }
  return null;
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

function formatDate(dateStr: string): string {
  if (!dateStr) return "N/A";
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function formatStatus(status: string): string {
  const statusMap: Record<string, string> = {
    scheduled: "Scheduled",
    recording: "Recording",
    recorded: "Recorded",
    muxed: "Muxed",
    cancelled: "Cancelled",
    failed: "Failed",
    missed: "Missed",
  };
  return statusMap[status] || status;
}
</script>

<style scoped>
.recording-detail {
  padding: 0;
}

.back {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-family: var(--mono);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: .14em;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--ink-soft);
  margin: 24px 0 0;
}

.back:hover {
  color: var(--fluoro);
}

.back::before {
  content: "←";
}

.detail-grid {
  display: grid;
  gap: 24px;
  grid-template-columns: minmax(0, 1fr);
}

.player {
  position: relative;
  aspect-ratio: 16/9;
  width: 100%;
  border: 2.5px solid var(--line);
  box-shadow: var(--sh);
  background:
    repeating-linear-gradient(45deg, rgba(23,20,42,.04) 0 12px, transparent 12px 24px),
    linear-gradient(150deg, #241f3d, #17142A 55%, #2a1550);
  overflow: hidden;
  display: grid;
  place-items: center;
}

.player::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image: radial-gradient(rgba(255,255,255,.10) 0.7px, transparent 0.8px);
  background-size: 6px 6px;
  pointer-events: none;
}

.player .frame {
  position: absolute;
  top: 12px;
  left: 12px;
  right: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: rgba(255,255,255,.72);
}

.player .frame .rec {
  color: var(--fluoro);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.player .frame .rec .blip {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fluoro);
}

.play-btn {
  position: relative;
  z-index: 2;
  width: 84px;
  height: 84px;
  border-radius: 50%;
  background: var(--fluoro);
  border: none;
  cursor: pointer;
  display: grid;
  place-items: center;
  box-shadow: 0 0 0 6px rgba(255,59,31,.22), 6px 6px 0 rgba(0,0,0,.35);
  transition: transform .15s ease;
}

.play-btn:hover {
  transform: scale(1.06);
}

.play-btn::before {
  content: "";
  width: 0;
  height: 0;
  margin-left: 6px;
  border-left: 26px solid #fff;
  border-top: 16px solid transparent;
  border-bottom: 16px solid transparent;
}

.player .scrub {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  height: 6px;
  background: rgba(255,255,255,.18);
  border-radius: 3px;
  overflow: hidden;
}

.player .scrub > i {
  position: absolute;
  inset: 0;
  right: 64%;
  background: var(--fluoro);
}

.video-player {
  width: 100%;
  height: 100%;
  background: #000;
}

.player--placeholder {
  align-items: flex-start;
  padding-top: 60px;
}

.not-ready {
  text-align: center;
  color: rgba(255, 255, 255, 0.8);
  font-size: 16px;
  font-family: var(--ui);
}

.not-ready p {
  margin: 8px 0;
}

.not-ready .status {
  font-family: var(--mono);
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  margin-top: 12px;
}

.not-ready b {
  color: rgba(255, 255, 255, 0.9);
}

.detail-title {
  font-family: var(--disp);
  text-transform: uppercase;
  font-weight: 400;
  font-size: clamp(34px, 10vw, 66px);
  line-height: .88;
  letter-spacing: .01em;
  margin: 4px 0 0;
}

.detail-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  margin-top: 12px;
}

.detail-sub .m {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--ink-soft);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.detail-sub .m b {
  color: var(--ink);
  font-weight: 700;
}

.col-info {
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
  margin: 0 0 12px 0;
}

.eyebrow::after {
  content: "";
  flex: 1;
  height: 2px;
  background: var(--line);
}

.urlbar {
  display: flex;
  gap: 0;
  border: 2.5px solid var(--line);
  box-shadow: var(--sh);
  background: var(--paper-2);
  align-items: stretch;
  margin-bottom: 10px;
}

.urlbar code {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 12.5px;
  padding: 12px 14px;
  color: var(--ink);
  white-space: nowrap;
  overflow-x: auto;
  display: flex;
  align-items: center;
}

.urlbar .copy {
  border: none;
  border-left: 2.5px solid var(--line);
  background: var(--violet);
  color: #fff;
  cursor: pointer;
  font-family: var(--ui);
  font-weight: 700;
  font-size: 12.5px;
  text-transform: uppercase;
  letter-spacing: .08em;
  padding: 0 18px;
  white-space: nowrap;
  transition: background .12s;
}

.urlbar .copy:hover {
  background: var(--violet-d);
}

.urlbar .copy.done {
  background: var(--fluoro);
}

.vlc-line {
  margin-bottom: 30px;
}

.vlc {
  font-family: var(--mono);
  font-size: 11.5px;
  letter-spacing: .04em;
  color: var(--ink-soft);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-style: dotted;
  cursor: pointer;
}

.vlc:hover {
  color: var(--violet);
}

.vlc-note {
  font-family: var(--mono);
  font-size: 10px;
  color: #8b8598;
  letter-spacing: .06em;
}

.edit-panel {
  margin-top: 20px;
  border: 2.5px solid var(--violet);
  padding: 16px;
  background: var(--paper-2);
}

.edit-field {
  margin-bottom: 12px;
}

.edit-field label {
  display: block;
  font-family: var(--mono);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--ink-soft);
  margin-bottom: 6px;
}

.input {
  width: 100%;
  font-family: var(--ui);
  font-size: 14px;
  padding: 10px 12px;
  border: 2px solid var(--line);
  background: var(--paper);
  color: var(--ink);
}

.input:focus {
  outline: none;
  border-color: var(--violet);
}

.edit-buttons {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.tbtn {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: .08em;
  text-transform: uppercase;
  border: 2px solid var(--line);
  background: var(--paper);
  padding: 8px 14px;
  cursor: pointer;
  color: var(--ink);
  transition: all .12s;
}

.tbtn:hover:not(:disabled) {
  box-shadow: 2px 2px 0 var(--ink);
  transform: translate(-1px, -1px);
}

.tbtn:disabled {
  opacity: .5;
  cursor: default;
}

.tbtn--save {
  border-color: var(--violet);
  color: var(--violet);
}

.tbtn--save:hover:not(:disabled) {
  background: var(--violet);
  color: #fff;
}

.edit-error {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 12px;
  color: var(--fluoro);
  margin: 0 0 12px;
}

.trash-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 24px;
}

.btn--trash {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: .08em;
  text-transform: uppercase;
  border: 2px solid var(--line);
  background: var(--paper);
  color: var(--ink-soft);
  padding: 7px 12px;
  cursor: pointer;
  transition: all .12s;
}

.btn--trash:hover {
  border-color: var(--fluoro);
  color: var(--fluoro);
  box-shadow: 2px 2px 0 var(--ink);
  transform: translate(-1px, -1px);
}

.trash-note {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: .06em;
  color: #8b8598;
}

.danger-error {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 12px;
  color: var(--fluoro);
  border: 2px solid var(--fluoro);
  background: var(--paper);
  padding: 8px 10px;
  max-width: none;
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

.btn--edit {
  margin-top: 20px;
  background: var(--violet);
  color: #fff;
  border-color: var(--violet);
}

.btn--edit:hover {
  background: var(--violet-d);
  color: #fff;
  box-shadow: 4px 4px 0 var(--ink);
}

.btn--download {
  margin-top: 20px;
  background: var(--paper);
  color: var(--violet);
  border-color: var(--violet);
}

.btn--download:hover {
  background: var(--violet);
  color: #fff;
  box-shadow: 4px 4px 0 var(--ink);
}

.loading {
  text-align: center;
  color: var(--ink-soft);
  padding: 2rem;
}

.orig__body {
  height: auto;
  overflow: visible;
}

.orig--collapsed {
  border: 2px solid var(--ink-soft);
  background: var(--paper);
  margin-bottom: 4px;
}

.orig--collapsed .orig__body {
  height: 0;
  overflow: hidden;
}

.orig__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 13px;
  cursor: pointer;
}

.orig__bar .l {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 10.5px;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--ink-soft);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.orig__bar .toggle {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 10px;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--violet);
}

.lineage {
  margin-top: 18px;
  border: 2px solid var(--violet);
  background: var(--paper);
  padding: 12px 14px;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  flex-wrap: wrap;
}

.lineage .ic {
  font-size: 15px;
  color: var(--violet);
  line-height: 1.2;
}

.lineage .txt {
  font-family: var(--mono);
  font-size: 11.5px;
  letter-spacing: .02em;
  color: var(--ink-soft);
  min-width: 0;
}

.lineage .txt b {
  color: var(--ink);
  font-weight: 700;
}

.lineage a {
  color: var(--violet);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-style: dotted;
  font-weight: 700;
  white-space: nowrap;
}

.recut {
  margin-top: 14px;
  border: 2px dashed var(--ink-soft);
  background: var(--paper);
  padding: 11px 14px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: .02em;
  color: var(--ink-soft);
}

.recut b {
  color: var(--ink);
}

.recut a {
  color: var(--violet);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-style: dotted;
  font-weight: 700;
}

@media (min-width: 768px) {
  .detail-sub .m {
    font-size: 12px;
  }
}

@media (min-width: 900px) {
  .detail-grid {
    grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
    align-items: start;
  }

  .detail-grid .col-media {
    grid-column: 1;
  }

  .detail-grid .col-info {
    grid-column: 2;
    position: sticky;
    top: 88px;
  }

  /* The Cut console needs real room for its per-piece preview + metadata
     forms, so it drops the two-column split and reflows to a single full-
     width column while a cut is in progress (mark/processing/preview). */
  .detail-grid.detail-grid--cut-open {
    grid-template-columns: minmax(0, 1fr);
  }

  .detail-grid.detail-grid--cut-open .col-info {
    grid-column: 1;
    position: static;
  }
}
</style>
