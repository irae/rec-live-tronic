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
              <video :src="piece.file_url" controls class="mini-video"></video>
            </div>

            <div class="piece-url">
              <code>{{ pieceStreamUrl(piece) }}</code>
              <button type="button" class="copy" @click="copyPieceUrl(piece)" :class="{ done: pieceCopyDone[piece.index] }">{{ pieceCopyDone[piece.index] ? "Copied ✓" : "Copy" }}</button>
            </div>
            <a v-if="isIos || isMac" class="vlc" :href="pieceVlcUrl(piece)">Open in VLC ↗</a>

            <label v-if="draft.pieces.length > 1" class="keepthis">
              <input type="checkbox" v-model="keepSelected" :value="piece.index" /> Keep this cut
            </label>

            <div v-if="pieceForms[piece.index]" class="piece-meta">
              <p class="piece-meta__label">Metadata for this piece</p>
              <div class="pfield">
                <label :for="`pf-title-${piece.index}`">Title</label>
                <input :id="`pf-title-${piece.index}`" class="input" type="text" v-model="pieceForms[piece.index].title" />
              </div>
              <div class="pfield">
                <label :for="`pf-artist-${piece.index}`">Artist</label>
                <input :id="`pf-artist-${piece.index}`" class="input" type="text" v-model="pieceForms[piece.index].artist" placeholder="optional label" />
              </div>
              <div class="pfield">
                <label :for="`pf-venue-${piece.index}`">Venue</label>
                <input :id="`pf-venue-${piece.index}`" class="input" type="text" v-model="pieceForms[piece.index].venue" placeholder="optional label" />
              </div>
              <div class="pfield">
                <label :for="`pf-event-${piece.index}`">Event</label>
                <input :id="`pf-event-${piece.index}`" class="input" type="text" v-model="pieceForms[piece.index].event" placeholder="optional label" />
              </div>
              <div class="pfield">
                <label :for="`pf-stage-${piece.index}`">Stage</label>
                <input :id="`pf-stage-${piece.index}`" class="input" type="text" v-model="pieceForms[piece.index].stage" placeholder="optional label" />
              </div>
            </div>
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
import { ref, watch } from "vue";
import { api, type CutDraft, type CutPiece, type Recording } from "../api";
import { parseOffsetInput, formatOffsetSeconds } from "../lib/cut-offsets";
import { isIosDevice, isMacDevice, vlcUrlFor } from "../lib/vlc";
import { copyText } from "../lib/copy";

interface SourceMeta {
  title: string;
  artist: string | null;
  venue: string | null;
  event: string | null;
  stage: string | null;
}

interface PieceForm {
  title: string;
  artist: string;
  venue: string;
  event: string;
  stage: string;
}

const props = defineProps<{
  recordingId: string;
  recording: SourceMeta;
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
const pieceForms = ref<Record<number, PieceForm>>({});
const pieceCopyDone = ref<Record<number, boolean>>({});

const isIos = isIosDevice();
const isMac = isMacDevice();

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
  pieceForms.value = {};
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
    pieceForms.value = Object.fromEntries(
      result.pieces.map((p) => [p.index, defaultsForPiece(p.index, result.mode)]),
    );
    phase.value = "preview";
  } catch (error) {
    console.error("Failed to create cut draft:", error);
    markError.value = error instanceof Error ? error.message : "Failed to make the cut";
    phase.value = "mark";
  } finally {
    submitting.value = false;
  }
}

function adjust(): void {
  phase.value = "mark";
}

// title default mirrors the server's own (trim keeps the source title;
// split appends "(part N)") -- see keepCutDraft in src/api/service.ts.
function defaultsForPiece(index: number, mode: "trim" | "split"): PieceForm {
  const src = props.recording;
  return {
    title: mode === "trim" ? src.title : `${src.title} (part ${index + 1})`,
    artist: src.artist ?? "",
    venue: src.venue ?? "",
    event: src.event ?? "",
    stage: src.stage ?? "",
  };
}

async function keep(): Promise<void> {
  if (!draftId.value || !draft.value) return;
  keepError.value = null;
  keeping.value = true;
  try {
    const overrides: Record<string, PieceForm> = {};
    for (const piece of draft.value.pieces) {
      const form = pieceForms.value[piece.index];
      if (form) overrides[String(piece.index)] = form;
    }
    const body = {
      ...(draft.value.pieces.length > 1 ? { keep: keepSelected.value } : {}),
      overrides,
    };
    const recordings = await api.keepCutDraft(props.recordingId, draftId.value, body);
    draftId.value = null;
    draft.value = null;
    pieceForms.value = {};
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

function pieceStreamUrl(piece: CutPiece): string {
  return `${window.location.origin}${piece.file_url}`;
}

function pieceVlcUrl(piece: CutPiece): string {
  return vlcUrlFor(pieceStreamUrl(piece));
}

async function copyPieceUrl(piece: CutPiece): Promise<void> {
  if (!(await copyText(pieceStreamUrl(piece)))) return;
  pieceCopyDone.value[piece.index] = true;
  setTimeout(() => {
    pieceCopyDone.value[piece.index] = false;
  }, 1600);
}

</script>

<style scoped>
.cutwrap { margin-top: 18px; }

.btn--cut-open {
  font-family: var(--ui);
  font-weight: 700;
  font-size: 13.5px;
  text-transform: uppercase;
  letter-spacing: .08em;
  border: 2.5px solid var(--fluoro);
  padding: 14px 22px;
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
  display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
  padding: 14px 18px; border-bottom: 2.5px solid var(--line); background: var(--ink); color: var(--paper);
}

.lbl { font-family: var(--mono); font-weight: 700; font-size: 11px; letter-spacing: .18em; text-transform: uppercase; display: inline-flex; align-items: center; gap: 8px; }
.lbl b { color: var(--fluoro); }

.modes { display: inline-flex; border: 2px solid var(--paper); }
.modes button {
  font-family: var(--mono); font-weight: 700; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase;
  padding: 6px 14px; background: transparent; color: var(--paper); border: none; cursor: pointer;
}
.modes button + button { border-left: 2px solid var(--paper); }
.modes button.active { background: var(--fluoro); color: #fff; }

.cutbar__body { padding: 24px 18px 18px; }

.cue-field { margin-bottom: 20px; }

.cue-label {
  display: block; font-family: var(--mono); font-weight: 700; font-size: 11px; letter-spacing: .1em;
  text-transform: uppercase; color: var(--ink-soft); margin-bottom: 8px;
}
.cue-label .req { color: var(--fluoro); }
.cue-label .opt { font-weight: 400; text-transform: none; letter-spacing: 0; }

.cue-input-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }

.pill {
  font-family: var(--mono); font-weight: 700; font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
  border: 2px solid var(--line); background: var(--paper); padding: 9px 14px; cursor: pointer; color: var(--ink);
  display: inline-flex; align-items: center; gap: 6px; transition: all .12s;
}
.pill:hover { transform: translate(-1px, -1px); box-shadow: 2px 2px 0 var(--ink); }
.pill--violet { border-color: var(--violet); color: var(--violet); }
.pill--remove { border-color: var(--ink-soft); color: var(--ink-soft); padding: 9px 11px; }

.tinput {
  font-family: var(--mono); font-size: 13px; padding: 9px 11px; border: 2px solid var(--line);
  background: var(--paper); color: var(--ink); width: 130px;
}
.tinput:focus { outline: none; border-color: var(--violet); }

.cue-hint { font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; color: var(--ink-soft); margin: 6px 0 0; }
.cue-error, .keep-error { font-family: var(--mono); font-weight: 700; font-size: 12px; color: var(--fluoro); margin: 14px 0 0; }

.mark-actions { margin-top: 26px; display: flex; gap: 12px; flex-wrap: wrap; border-top: 2px solid var(--line); padding-top: 20px; }

.rbtn {
  font-family: var(--ui); font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
  border: 2.5px solid var(--line); padding: 12px 22px; cursor: pointer; background: var(--paper); color: var(--ink);
  display: inline-flex; align-items: center; gap: 8px; transition: transform .12s, box-shadow .12s, background .12s;
}
.rbtn:hover:not(:disabled) { transform: translate(-2px, -2px); box-shadow: 4px 4px 0 var(--ink); }
.rbtn:disabled { opacity: .5; cursor: default; }
.rbtn--discard { border-color: var(--ink-soft); color: var(--ink-soft); }
.rbtn--keep { background: var(--violet); color: #fff; border-color: var(--violet); }
.rbtn--keep:hover:not(:disabled) { background: var(--violet-d); box-shadow: 4px 4px 0 var(--ink); }

.btn.cut-primary {
  background: var(--fluoro); color: #fff; border-color: var(--fluoro);
  font-family: var(--ui); font-weight: 700; font-size: 13.5px; text-transform: uppercase; letter-spacing: .08em;
  border-width: 2.5px; padding: 14px 22px; cursor: pointer; width: auto;
}
.btn.cut-primary:hover:not(:disabled) { background: var(--fluoro); box-shadow: 4px 4px 0 var(--ink); transform: translate(-2px, -2px); }
.btn.cut-primary:disabled { opacity: .6; cursor: default; }

.proc-inline { text-align: center; padding: 48px 18px 40px; }
.proc-inline .big { font-family: var(--disp); text-transform: uppercase; font-size: clamp(28px, 7vw, 40px); line-height: .9; letter-spacing: .02em; color: var(--ink); }
.proc-inline .sub { font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-soft); margin-top: 16px; }
.proc__bar { width: 240px; max-width: 60vw; height: 8px; margin: 20px auto 0; background: var(--paper-2); overflow: hidden; border: 1px solid var(--line); }
.proc__bar i { display: block; height: 100%; width: 40%; background: var(--fluoro); animation: march 1.1s linear infinite; }
@keyframes march { 0% { transform: translateX(-120%); } 100% { transform: translateX(320%); } }

.eyebrow {
  font-family: var(--mono); font-weight: 700; font-size: 11px; letter-spacing: .22em; text-transform: uppercase;
  color: var(--ink-soft); display: flex; align-items: center; gap: 10px; margin: 20px 18px 12px;
}
.eyebrow::after { content: ""; flex: 1; height: 2px; background: var(--line); }
.room-note { font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; color: var(--ink-soft); margin: 0 18px 20px; }

.cuts { display: grid; gap: 20px; padding: 0 18px 18px; }
@media (min-width: 1080px) { .cuts--split { grid-template-columns: 1fr 1fr; } }

.cutcard {
  border: 2.5px dashed var(--fluoro);
  background: repeating-linear-gradient(45deg, rgba(255,59,31,.055) 0 10px, transparent 10px 20px);
  padding: 18px; display: grid; gap: 14px;
  /* Both explicit: an implicit "auto" column still sizes to its widest
     child's max-content (here, .mini's video preview), even once the outer
     .cuts grid's own columns are correctly constrained -- so a two-up split
     overflowed the page instead of the columns ever actually being 1fr.
     minmax(0, 1fr) makes the single column definite and shrinkable; the
     matching min-width: 0 stops THIS card from doing the same thing one
     level up, inside .cuts. */
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
}
.cutcard__top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.cutcard__no { font-family: var(--mono); font-weight: 700; font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: var(--fluoro); }
.cutcard__span { font-family: var(--mono); font-size: 10.5px; letter-spacing: .04em; color: var(--ink-soft); }
.cutcard__span b { color: var(--ink); }

.mini { position: relative; aspect-ratio: 16/9; border: 2px solid var(--line); overflow: hidden; background: #17142A; min-width: 0; }
/* Absolutely positioned so the video's own intrinsic size (e.g. 1280x720)
   never contributes to .mini's layout size -- .mini is sized purely by its
   aspect-ratio. Without this, a <video>'s intrinsic width wins out over its
   percentage width when an ancestor grid track sizes to content (nested
   grids: .cutcard's own auto column sizes to its widest child's max-content,
   even after the outer .cuts grid's columns are correctly constrained). */
.mini-video { position: absolute; inset: 0; width: 100%; height: 100%; background: #000; }
.mini__tag {
  position: absolute; top: 9px; left: 9px; font-family: var(--mono); font-size: 9px; letter-spacing: .12em;
  text-transform: uppercase; color: rgba(255,255,255,.72); z-index: 2; pointer-events: none;
}

.keepthis {
  display: inline-flex; align-items: center; gap: 8px; font-family: var(--mono); font-weight: 700; font-size: 10px;
  letter-spacing: .1em; text-transform: uppercase; color: var(--ink-soft); cursor: pointer; user-select: none;
}
.keepthis input { accent-color: var(--violet); width: 16px; height: 16px; cursor: pointer; }

.piece-url {
  display: flex; border: 2px solid var(--line); background: var(--paper-2); align-items: stretch;
}
.piece-url code {
  flex: 1; min-width: 0; font-family: var(--mono); font-size: 10.5px; padding: 10px 12px; color: var(--ink);
  white-space: nowrap; overflow-x: auto; display: flex; align-items: center;
}
.piece-url .copy {
  border: none; border-left: 2px solid var(--line); background: var(--violet); color: #fff; cursor: pointer;
  font-family: var(--ui); font-weight: 700; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em;
  padding: 0 14px; white-space: nowrap; transition: background .12s;
}
.piece-url .copy:hover { background: var(--violet-d); }
.piece-url .copy.done { background: var(--fluoro); }

.vlc {
  align-self: flex-start; font-family: var(--mono); font-size: 10.5px; letter-spacing: .04em; color: var(--ink-soft);
  text-decoration: underline; text-underline-offset: 3px; text-decoration-style: dotted; cursor: pointer;
}
.vlc:hover { color: var(--violet); }

.piece-meta { border-top: 2px dashed var(--ink-soft); padding-top: 14px; display: grid; gap: 12px; margin-top: 6px; }
.piece-meta__label {
  margin: 0; font-family: var(--mono); font-weight: 700; font-size: 10px; letter-spacing: .12em;
  text-transform: uppercase; color: var(--ink-soft);
}
.pfield { display: grid; gap: 6px; }
.pfield label {
  display: block; font-family: var(--mono); font-weight: 700; font-size: 10px; letter-spacing: .08em;
  text-transform: uppercase; color: var(--ink-soft);
}
.pfield .input {
  width: 100%; font-family: var(--ui); font-size: 13px; padding: 9px 11px; border: 2px solid var(--line);
  background: var(--paper); color: var(--ink);
}
.pfield .input:focus { outline: none; border-color: var(--violet); }

@media (min-width: 520px) {
  .piece-meta { grid-template-columns: 1fr 1fr; }
  .piece-meta__label { grid-column: 1 / -1; }
}

.review {
  margin: 8px 18px 18px; border-top: 2.5px dashed var(--fluoro); padding-top: 20px;
  display: flex; gap: 12px; flex-wrap: wrap; align-items: center;
}
.review .note { font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; color: var(--ink-soft); margin-right: auto; max-width: 36ch; }
</style>
