<template>
  <div class="cutwrap">
    <button v-if="!open" type="button" class="btn btn--cut-open" @click="openConsole">✂ Cut this recording</button>

    <div v-if="open" class="cutbar">
      <!-- MARK -->
      <template v-if="phase === 'mark'">
        <div class="cutbar__head">
          <span class="lbl">✂ <b>Cut</b> &nbsp;·&nbsp; drop cue points</span>
          <div class="modes">
            <button type="button" :class="{ active: mode === 'trim' }" @click="mode = 'trim'">Trim</button>
            <button type="button" :class="{ active: mode === 'split' }" @click="mode = 'split'">Split</button>
          </div>
        </div>
        <div class="cutbar__body">
          <template v-if="mode === 'trim'">
            <div class="cue-field">
              <span class="cue-label">Cue in <span class="req">*</span></span>
              <div class="cue-input-row">
                <button type="button" class="pill pill--violet" @click="grab('in')">Grab from player</button>
                <input class="tinput" type="text" v-model="cueIn" placeholder="H:MM:SS" @blur="normalize('in')" />
              </div>
            </div>
            <div class="cue-field">
              <span class="cue-label">Cue out <span class="opt">(optional — defaults to end)</span></span>
              <div class="cue-input-row">
                <button type="button" class="pill pill--violet" @click="grab('out')">Grab from player</button>
                <input class="tinput" type="text" v-model="cueOut" placeholder="H:MM:SS" @blur="normalize('out')" />
              </div>
            </div>
            <p class="cue-hint">Keep the range between Cue in and Cue out. Everything outside it is dropped.</p>
          </template>

          <template v-else>
            <div v-for="(cut, idx) in cuts" :key="idx" class="cue-field">
              <span class="cue-label">Cut point {{ idx + 1 }}</span>
              <div class="cue-input-row">
                <button type="button" class="pill pill--violet" @click="grabCut(idx)">Grab from player</button>
                <input class="tinput" type="text" v-model="cuts[idx]" placeholder="H:MM:SS" @blur="normalizeCut(idx)" />
                <button type="button" class="pill pill--remove" title="Remove cut point" @click="removeCut(idx)">✕</button>
              </div>
            </div>
            <button type="button" class="pill" @click="addCut">+ Add cut point</button>
            <p class="cue-hint">{{ cuts.length }} cut point{{ cuts.length === 1 ? "" : "s" }} · makes {{ cuts.length + 1 }} pieces.</p>
          </template>

          <p v-if="markError" class="cue-error">{{ markError }}</p>

          <div class="mark-actions">
            <button type="button" class="rbtn rbtn--discard" @click="closeConsole">✕ {{ draftId ? "Cancel" : "Close" }}</button>
            <button type="button" class="btn cut-primary" :disabled="submitting" @click="makeCut">{{ submitting ? "Making the cut…" : "✂ Make the cut" }}</button>
          </div>
        </div>
      </template>

      <!-- PROCESSING -->
      <template v-else-if="phase === 'processing'">
        <div class="proc-inline">
          <div class="big">Making<br>the cut…</div>
          <div class="proc__bar"><i></i></div>
          <div class="sub">ffmpeg -c copy · no re-encode · a few seconds</div>
        </div>
      </template>

      <!-- PREVIEW -->
      <template v-else-if="phase === 'preview' && draft">
        <p class="eyebrow">Cutting room</p>
        <p class="room-note">{{ draft.pieces.length === 1 ? "One rough cut, ready to review" : `${draft.pieces.length} rough cuts from one split` }} — nothing saved to the Archive until you keep it.</p>

        <div class="cuts" :class="{ 'cuts--split': draft.pieces.length > 1 }">
          <div v-for="piece in draft.pieces" :key="piece.index" class="cutcard">
            <div class="cutcard__top">
              <span class="cutcard__no">✂ {{ draft.pieces.length === 1 ? "The cut" : `Cut ${piece.index + 1}` }}</span>
              <span class="cutcard__span"><b>{{ piece.start }} → {{ piece.end }}</b> · {{ piece.duration }}</span>
            </div>
            <div class="mini">
              <span class="mini__tag">rough cut · preview</span>
              <video :ref="(el) => setPieceEl(piece.index, el as HTMLVideoElement | null)" controls class="mini-video"></video>
            </div>
            <label v-if="draft.pieces.length > 1" class="keepthis">
              <input type="checkbox" v-model="keepSelected" :value="piece.index" /> Keep this cut
            </label>
          </div>
        </div>

        <p v-if="keepError" class="cue-error">{{ keepError }}</p>

        <div class="review">
          <span class="note">Keep and it joins the Archive as its own recording, linked back to this source. Adjust to nudge the points — the original is untouched either way.</span>
          <button type="button" class="rbtn rbtn--discard" @click="adjust">↺ Adjust</button>
          <button type="button" class="rbtn rbtn--keep" :disabled="keeping || (draft.pieces.length > 1 && keepSelected.length === 0)" @click="keep">
            {{ keeping ? "Keeping…" : draft.pieces.length > 1 ? "✓ Keep selected" : "✓ Keep" }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted } from "vue";
import mpegts from "mpegts.js";
import { api, type CutDraft, type Recording } from "../api";
import { parseOffsetInput, formatOffsetSeconds } from "../lib/cut-offsets";

const props = defineProps<{
  recordingId: string;
  getCurrentTime: () => number | null;
}>();

const emit = defineEmits<{
  "phase-change": [phase: "mark" | "processing" | "preview" | "closed"];
  kept: [recordings: Recording[]];
}>();

const open = ref(false);
const phase = ref<"mark" | "processing" | "preview">("mark");
const mode = ref<"trim" | "split">("trim");
const cueIn = ref("");
const cueOut = ref("");
const cuts = ref<string[]>([""]);
const markError = ref<string | null>(null);
const keepError = ref<string | null>(null);
const submitting = ref(false);
const keeping = ref(false);
const draftId = ref<string | null>(null);
const draft = ref<CutDraft | null>(null);
const keepSelected = ref<number[]>([]);

const useMpegts = mpegts.isSupported();
const piecePlayers = new Map<number, ReturnType<typeof mpegts.createPlayer>>();
const pieceEls = new Map<number, HTMLVideoElement>();

watch(phase, (value) => emit("phase-change", value === "mark" && !open.value ? "closed" : phase.value));
watch(open, (value) => emit("phase-change", value ? phase.value : "closed"));

function openConsole(): void {
  open.value = true;
  phase.value = "mark";
}

function closeConsole(): void {
  if (draftId.value) {
    api.abandonCutDraft(props.recordingId, draftId.value).catch((error) => {
      console.error("Failed to abandon cut draft:", error);
    });
    draftId.value = null;
    draft.value = null;
  }
  destroyPiecePlayers();
  open.value = false;
  phase.value = "mark";
  markError.value = null;
}

function addCut(): void {
  cuts.value.push("");
}

function removeCut(idx: number): void {
  cuts.value.splice(idx, 1);
  if (cuts.value.length === 0) cuts.value.push("");
}

function grab(target: "in" | "out"): void {
  const time = props.getCurrentTime();
  if (time === null) return;
  const formatted = formatOffsetSeconds(time);
  if (target === "in") cueIn.value = formatted;
  else cueOut.value = formatted;
}

function grabCut(idx: number): void {
  const time = props.getCurrentTime();
  if (time === null) return;
  cuts.value[idx] = formatOffsetSeconds(time);
}

function normalize(target: "in" | "out"): void {
  const raw = target === "in" ? cueIn.value : cueOut.value;
  if (!raw.trim()) return;
  const seconds = parseOffsetInput(raw);
  if (seconds === null) return;
  if (target === "in") cueIn.value = formatOffsetSeconds(seconds);
  else cueOut.value = formatOffsetSeconds(seconds);
}

function normalizeCut(idx: number): void {
  const raw = cuts.value[idx];
  if (!raw || !raw.trim()) return;
  const seconds = parseOffsetInput(raw);
  if (seconds === null) return;
  cuts.value[idx] = formatOffsetSeconds(seconds);
}

async function makeCut(): Promise<void> {
  markError.value = null;
  let body: unknown;
  if (mode.value === "trim") {
    const start = parseOffsetInput(cueIn.value);
    if (start === null) {
      markError.value = "Cue in is required and must look like H:MM:SS, MM:SS, or SS.";
      return;
    }
    const trimmedOut = cueOut.value.trim();
    if (trimmedOut && parseOffsetInput(trimmedOut) === null) {
      markError.value = "Cue out must look like H:MM:SS, MM:SS, or SS.";
      return;
    }
    body = { mode: "trim", start: cueIn.value.trim(), ...(trimmedOut ? { end: trimmedOut } : {}) };
  } else {
    const values = cuts.value.map((c) => c.trim()).filter((c) => c !== "");
    if (values.length === 0) {
      markError.value = "Add at least one cut point.";
      return;
    }
    for (const value of values) {
      if (parseOffsetInput(value) === null) {
        markError.value = "Every cut point must look like H:MM:SS, MM:SS, or SS.";
        return;
      }
    }
    body = { mode: "split", cuts: values };
  }

  submitting.value = true;
  phase.value = "processing";
  try {
    const result = await api.createCutDraft(props.recordingId, body);
    draftId.value = result.id;
    draft.value = result;
    keepSelected.value = result.pieces.map((p) => p.index);
    phase.value = "preview";
    await nextTick();
    setupPiecePlayers();
  } catch (error) {
    console.error("Failed to create cut draft:", error);
    markError.value = error instanceof Error ? error.message : "Failed to make the cut";
    phase.value = "mark";
  } finally {
    submitting.value = false;
  }
}

function adjust(): void {
  destroyPiecePlayers();
  phase.value = "mark";
}

async function keep(): Promise<void> {
  if (!draftId.value || !draft.value) return;
  keepError.value = null;
  keeping.value = true;
  try {
    const body = draft.value.pieces.length > 1 ? { keep: keepSelected.value } : {};
    const recordings = await api.keepCutDraft(props.recordingId, draftId.value, body);
    destroyPiecePlayers();
    draftId.value = null;
    draft.value = null;
    open.value = false;
    phase.value = "mark";
    emit("kept", recordings);
  } catch (error) {
    console.error("Failed to keep cut draft:", error);
    keepError.value = error instanceof Error ? error.message : "Failed to keep the cut";
  } finally {
    keeping.value = false;
  }
}

function setPieceEl(index: number, el: HTMLVideoElement | null): void {
  if (el) pieceEls.set(index, el);
  else pieceEls.delete(index);
}

function setupPiecePlayers(): void {
  if (!draft.value) return;
  for (const piece of draft.value.pieces) {
    const el = pieceEls.get(piece.index);
    if (!el) continue;
    if (!useMpegts) {
      el.src = piece.file_url;
      continue;
    }
    const player = mpegts.createPlayer({ type: "mpegts", url: piece.file_url, isLive: false }, {});
    player.on(mpegts.Events.ERROR, (type: string, detail: string) => {
      console.error("mpegts.js piece playback error:", piece.index, type, detail);
    });
    player.attachMediaElement(el);
    player.load();
    piecePlayers.set(piece.index, player);
  }
}

function destroyPiecePlayers(): void {
  for (const player of piecePlayers.values()) {
    try {
      player.pause();
      player.unload();
      player.detachMediaElement();
      player.destroy();
    } catch (error) {
      console.error("Failed to tear down a piece player:", error);
    }
  }
  piecePlayers.clear();
}

onUnmounted(() => {
  destroyPiecePlayers();
});
</script>

<style scoped>
.cutwrap { margin-top: 14px; }

.btn--cut-open {
  font-family: var(--ui);
  font-weight: 700;
  font-size: 13.5px;
  text-transform: uppercase;
  letter-spacing: .08em;
  border: 2.5px solid var(--fluoro);
  padding: 12px 18px;
  cursor: pointer;
  background: var(--paper);
  color: var(--fluoro);
  width: 100%;
  transition: transform .12s ease, box-shadow .12s ease, background .12s;
}

.btn--cut-open:hover {
  background: var(--fluoro);
  color: #fff;
  transform: translate(-2px, -2px);
  box-shadow: 4px 4px 0 var(--ink);
}

.cutbar { border: 2.5px solid var(--line); box-shadow: var(--sh); background: var(--paper); }

.cutbar__head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
  padding: 11px 14px; border-bottom: 2.5px solid var(--line); background: var(--ink); color: var(--paper);
}

.lbl { font-family: var(--mono); font-weight: 700; font-size: 11px; letter-spacing: .18em; text-transform: uppercase; display: inline-flex; align-items: center; gap: 8px; }
.lbl b { color: var(--fluoro); }

.modes { display: inline-flex; border: 2px solid var(--paper); }
.modes button {
  font-family: var(--mono); font-weight: 700; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase;
  padding: 5px 12px; background: transparent; color: var(--paper); border: none; cursor: pointer;
}
.modes button + button { border-left: 2px solid var(--paper); }
.modes button.active { background: var(--fluoro); color: #fff; }

.cutbar__body { padding: 18px 14px 14px; }

.cue-field { margin-bottom: 14px; }

.cue-label {
  display: block; font-family: var(--mono); font-weight: 700; font-size: 11px; letter-spacing: .1em;
  text-transform: uppercase; color: var(--ink-soft); margin-bottom: 6px;
}
.cue-label .req { color: var(--fluoro); }
.cue-label .opt { font-weight: 400; text-transform: none; letter-spacing: 0; }

.cue-input-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

.pill {
  font-family: var(--mono); font-weight: 700; font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
  border: 2px solid var(--line); background: var(--paper); padding: 8px 12px; cursor: pointer; color: var(--ink);
  display: inline-flex; align-items: center; gap: 6px; transition: all .12s;
}
.pill:hover { transform: translate(-1px, -1px); box-shadow: 2px 2px 0 var(--ink); }
.pill--violet { border-color: var(--violet); color: var(--violet); }
.pill--remove { border-color: var(--ink-soft); color: var(--ink-soft); padding: 8px 10px; }

.tinput {
  font-family: var(--mono); font-size: 13px; padding: 8px 10px; border: 2px solid var(--line);
  background: var(--paper); color: var(--ink); width: 120px;
}
.tinput:focus { outline: none; border-color: var(--violet); }

.cue-hint { font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; color: var(--ink-soft); margin: 4px 0 0; }
.cue-error, .keep-error { font-family: var(--mono); font-weight: 700; font-size: 12px; color: var(--fluoro); margin: 10px 0 0; }

.mark-actions { margin-top: 18px; display: flex; gap: 10px; flex-wrap: wrap; }

.rbtn {
  font-family: var(--ui); font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
  border: 2.5px solid var(--line); padding: 11px 20px; cursor: pointer; background: var(--paper); color: var(--ink);
  display: inline-flex; align-items: center; gap: 8px; transition: transform .12s, box-shadow .12s, background .12s;
}
.rbtn:hover:not(:disabled) { transform: translate(-2px, -2px); box-shadow: 4px 4px 0 var(--ink); }
.rbtn:disabled { opacity: .5; cursor: default; }
.rbtn--discard { border-color: var(--ink-soft); color: var(--ink-soft); }
.rbtn--keep { background: var(--violet); color: #fff; border-color: var(--violet); }
.rbtn--keep:hover:not(:disabled) { background: var(--violet-d); box-shadow: 4px 4px 0 var(--ink); }

.btn.cut-primary {
  margin-top: 4px; background: var(--fluoro); color: #fff; border-color: var(--fluoro);
  font-family: var(--ui); font-weight: 700; font-size: 13.5px; text-transform: uppercase; letter-spacing: .08em;
  border-width: 2.5px; padding: 12px 18px; cursor: pointer; width: auto;
}
.btn.cut-primary:hover:not(:disabled) { background: var(--fluoro); box-shadow: 4px 4px 0 var(--ink); transform: translate(-2px, -2px); }
.btn.cut-primary:disabled { opacity: .6; cursor: default; }

.proc-inline { text-align: center; padding: 32px 14px; }
.proc-inline .big { font-family: var(--disp); text-transform: uppercase; font-size: clamp(24px, 6vw, 34px); line-height: .9; letter-spacing: .02em; color: var(--ink); }
.proc-inline .sub { font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-soft); margin-top: 12px; }
.proc__bar { width: 220px; max-width: 60vw; height: 8px; margin: 16px auto 0; background: var(--paper-2); overflow: hidden; border: 1px solid var(--line); }
.proc__bar i { display: block; height: 100%; width: 40%; background: var(--fluoro); animation: march 1.1s linear infinite; }
@keyframes march { 0% { transform: translateX(-120%); } 100% { transform: translateX(320%); } }

.eyebrow {
  font-family: var(--mono); font-weight: 700; font-size: 11px; letter-spacing: .22em; text-transform: uppercase;
  color: var(--ink-soft); display: flex; align-items: center; gap: 10px; margin: 14px 14px 8px;
}
.eyebrow::after { content: ""; flex: 1; height: 2px; background: var(--line); }
.room-note { font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; color: var(--ink-soft); margin: 0 14px 14px; }

.cuts { display: grid; gap: 16px; padding: 0 14px 14px; }
@media (min-width: 640px) { .cuts--split { grid-template-columns: 1fr 1fr; } }

.cutcard {
  border: 2.5px dashed var(--fluoro);
  background: repeating-linear-gradient(45deg, rgba(255,59,31,.055) 0 10px, transparent 10px 20px);
  padding: 14px; display: grid; gap: 11px;
}
.cutcard__top { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.cutcard__no { font-family: var(--mono); font-weight: 700; font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--fluoro); }
.cutcard__span { font-family: var(--mono); font-size: 10.5px; letter-spacing: .04em; color: var(--ink-soft); }
.cutcard__span b { color: var(--ink); }

.mini { position: relative; aspect-ratio: 16/9; border: 2px solid var(--line); overflow: hidden; background: #17142A; }
.mini-video { width: 100%; height: 100%; background: #000; }
.mini__tag {
  position: absolute; top: 9px; left: 9px; font-family: var(--mono); font-size: 9px; letter-spacing: .12em;
  text-transform: uppercase; color: rgba(255,255,255,.72); z-index: 2; pointer-events: none;
}

.keepthis {
  display: inline-flex; align-items: center; gap: 7px; font-family: var(--mono); font-weight: 700; font-size: 10px;
  letter-spacing: .1em; text-transform: uppercase; color: var(--ink-soft); cursor: pointer; user-select: none;
}
.keepthis input { accent-color: var(--violet); width: 15px; height: 15px; }

.review {
  margin: 6px 14px 14px; border-top: 2.5px dashed var(--fluoro); padding-top: 16px;
  display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
}
.review .note { font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; color: var(--ink-soft); margin-right: auto; max-width: 34ch; }
</style>
