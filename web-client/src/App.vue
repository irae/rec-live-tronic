<template>
  <div id="app" class="app">
    <header class="mast">
      <span class="brand">
        Tronic<span class="dot"></span>
        <small>rec · {{ view === 'archive' ? 'archive' : view === 'schedule' ? 'schedule' : 'set' }}</small>
      </span>
      <nav class="nav">
        <a href="#" @click.prevent="view = 'archive'" :aria-current="view === 'archive' ? 'page' : undefined">Archive</a>
        <a href="#" @click.prevent="view = 'schedule'" :aria-current="view === 'schedule' ? 'page' : undefined">Schedule</a>
      </nav>
    </header>

    <main class="wrap">
      <ArchiveView :key="refreshKey" v-show="view === 'archive'" @select-recording="selectRecording" :selected-id="selectedId" />
      <ScheduleView v-show="view === 'schedule'" @select-recording="selectRecording" :selected-id="selectedId" />
      <RecordingDetail v-show="view === 'detail'" :recording-id="selectedId" @back="goBackToArchive" @deleted="refreshKey++" />
    </main>

    <footer class="foot">
      <span>Tronic <span class="dot">●</span> personal stream recorder</span>
      <span id="footer-stats">recorded · scheduled</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import ArchiveView from "./views/ArchiveView.vue";
import ScheduleView from "./views/ScheduleView.vue";
import RecordingDetail from "./views/RecordingDetail.vue";

const view = ref("archive");
const selectedId = ref<string | null>(null);
const refreshKey = ref(0);

function selectRecording(id: string): void {
  selectedId.value = id;
  view.value = "detail";
}

function goBackToArchive(): void {
  selectedId.value = null;
  view.value = "archive";
}
</script>

<style>
@import url('https://fonts.googleapis.com/css2?family=Anton&family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap');

:root {
  --paper:    #E6E1D4;
  --paper-2:  #DCD5C3;
  --ink:      #17142A;
  --ink-soft: #464056;
  --fluoro:   #FF3B1F;
  --violet:   #5B2CE0;
  --violet-d: #4a20bf;
  --line:     #17142A;

  --stub-r: 7px;
  --gap: clamp(14px, 4vw, 22px);
  --edge: clamp(16px, 5vw, 28px);

  --sh: 4px 4px 0 var(--ink);
  --sh-lift: 6px 6px 0 var(--ink);

  --disp: 'Anton', 'Arial Narrow', sans-serif;
  --ui:   'Space Grotesk', system-ui, sans-serif;
  --mono: 'Space Mono', ui-monospace, monospace;
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; overflow-x: hidden; }

body {
  margin: 0;
  font-family: var(--ui);
  color: var(--ink);
  background-color: var(--paper);
  background-image: radial-gradient(var(--ink) 0.6px, transparent 0.7px);
  background-size: 7px 7px;
  background-position: 0 0;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}

a { color: inherit; text-decoration: none; }

.wrap { max-width: 1160px; margin: 0 auto; padding: 0 var(--edge) 80px; }

.mast {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px;
  padding: 16px var(--edge);
  border-bottom: 2.5px solid var(--line);
  background: var(--paper);
  position: sticky; top: 0; z-index: 40;
  background-image: radial-gradient(var(--ink) 0.6px, transparent 0.7px);
  background-size: 7px 7px;
}

.brand {
  font-family: var(--disp);
  font-size: 26px;
  letter-spacing: .04em;
  text-transform: uppercase;
  display: inline-flex; align-items: baseline; gap: 9px;
  line-height: 1;
}

.brand .dot {
  width: 12px; height: 12px; border-radius: 50%;
  background: var(--fluoro);
  display: inline-block;
  box-shadow: 0 0 0 3px rgba(255,59,31,.25);
  align-self: center;
}

.brand small {
  font-family: var(--mono); font-size: 10px; letter-spacing: .18em;
  color: var(--ink-soft); text-transform: uppercase; font-weight: 700;
}

@media (max-width: 480px) { .brand small { display: none; } }

.nav { display: flex; gap: 6px; flex-shrink: 0; }
.brand { min-width: 0; }

.nav a {
  font-family: var(--ui); font-weight: 700; font-size: 12.5px;
  text-transform: uppercase; letter-spacing: .08em;
  text-decoration: none;
  padding: 8px 13px;
  border: 2px solid var(--line);
  background: var(--paper);
  transition: transform .12s ease, box-shadow .12s ease, background .12s;
  cursor: pointer;
}

.nav a:hover { transform: translate(-2px,-2px); box-shadow: 3px 3px 0 var(--ink); }

.nav a[aria-current="page"] { background: var(--ink); color: var(--paper); }

.nav a[aria-current="page"]:hover { box-shadow: 3px 3px 0 var(--fluoro); }

.foot {
  margin-top: 60px; padding-top: 18px; border-top: 2.5px solid var(--line);
  font-family: var(--mono); font-size: 10.5px; letter-spacing: .12em;
  text-transform: uppercase; color: var(--ink-soft);
  display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding-left: var(--edge);
  padding-right: var(--edge);
  padding-bottom: 18px;
}

.foot .dot { color: var(--fluoro); }

@keyframes pulse { 0%,100%{opacity:1; transform:scale(1);} 50%{opacity:.35; transform:scale(.7);} }
</style>

<style scoped>
#app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
</style>
