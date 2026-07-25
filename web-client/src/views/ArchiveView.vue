<template>
  <div class="archive-view">
    <section class="hero">
      <span class="stamp"><span class="blip"></span>captured live</span>
      <h1>Your<br>Lineup</h1>
      <p class="lede">Every set you pulled off the stream, kept as a file you own. Newest at the top of the bill.</p>
    </section>

    <div class="toolbar">
      <p class="eyebrow">Recorded sets <span class="count">{{ sortedRecordings.length }}</span></p>
      <div class="toolbar-controls">
        <button
          type="button"
          class="delete-toggle"
          :class="{ 'delete-toggle--active': deleteMode }"
          @click="deleteMode = !deleteMode"
        >{{ deleteMode ? "Done" : "🗑 Quick delete" }}</button>
        <select
          v-model="sortBy"
          class="sort-select"
          aria-label="Sort recordings by"
        >
          <option value="created">Date created</option>
          <option value="recorded">Date recorded</option>
          <option value="title">Title</option>
          <option value="artist">Artist</option>
          <option value="venue">Venue</option>
          <option value="event">Event</option>
        </select>
      </div>
    </div>

    <RecordingList
      :recordings="sortedRecordings"
      :empty-message="sortedRecordings.length === 0 ? 'No finished recordings yet.' : ''"
      :delete-mode="deleteMode"
      @select="selectRecording"
      @delete="handleDelete"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { api, recordings as sharedRecordings, type Recording } from "../api";
import RecordingList from "../components/RecordingList.vue";
import { useToast } from "../composables/useToast";

const { toast } = useToast();

const router = useRouter();

// Derived from the shared, App.vue-polled recordings list, so this view
// never goes stale even when it's left mounted without a poll of its own.
const recordings = computed(() => sharedRecordings.value.filter((rec) => rec.status === "recorded"));
const deleteMode = ref(false);
const deletingIds = ref<Set<string>>(new Set());
const sortBy = ref<"created" | "recorded" | "title" | "artist" | "venue" | "event">("created");

// Best-effort extraction of artist from title (assumed to be first segment).
// Looks for " - " or " @ " as separators, treating the part before the first
// one as the artist (e.g. "Artist Name - Set Title" or "Artist @ Venue").
function extractArtistFromTitle(title: string): string | null {
  const dashIndex = title.indexOf(" - ");
  const atIndex = title.indexOf(" @ ");
  let splitIndex = -1;

  if (dashIndex >= 0 && atIndex >= 0) {
    splitIndex = Math.min(dashIndex, atIndex);
  } else if (dashIndex >= 0) {
    splitIndex = dashIndex;
  } else if (atIndex >= 0) {
    splitIndex = atIndex;
  }

  return splitIndex >= 0 ? title.substring(0, splitIndex).trim() : null;
}

// Best-effort extraction of venue from title (assumed to be after "@").
// Only returns a value if an "@" is present, otherwise null (don't invent a venue).
function extractVenueFromTitle(title: string): string | null {
  const atIndex = title.indexOf(" @ ");
  if (atIndex < 0) return null;
  return title.substring(atIndex + 3).trim();
}

// Get the effective value for sorting: use the field if present, else try
// best-effort extraction from title, else null. Values that are null or empty
// string sort last (after all real/extracted values).
function getArtistValue(rec: Recording): string {
  if (rec.artist) return rec.artist;
  const extracted = extractArtistFromTitle(rec.title);
  return extracted || "￿"; // Sort empty/null last by using max Unicode char
}

function getVenueValue(rec: Recording): string {
  if (rec.venue) return rec.venue;
  const extracted = extractVenueFromTitle(rec.title);
  return extracted || "￿"; // Sort empty/null last
}

function compareRecordings(a: Recording, b: Recording): number {
  switch (sortBy.value) {
    case "created":
      // Default: preserve server order (no-op sort)
      return 0;

    case "recorded":
      // Sort by startAt DESC (most recent event first)
      return new Date(b.startAt).getTime() - new Date(a.startAt).getTime();

    case "title":
      // Sort alphabetically ASC (case-insensitive)
      return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });

    case "artist":
      // Sort alphabetically ASC (case-insensitive), with null/empty last
      return getArtistValue(a).localeCompare(getArtistValue(b), undefined, {
        sensitivity: "base",
      });

    case "venue":
      // Sort alphabetically ASC (case-insensitive), with null/empty last
      return getVenueValue(a).localeCompare(getVenueValue(b), undefined, {
        sensitivity: "base",
      });

    case "event":
      // Sort alphabetically ASC (case-insensitive)
      const eventA = a.event || "￿";
      const eventB = b.event || "￿";
      return eventA.localeCompare(eventB, undefined, { sensitivity: "base" });

    default:
      return 0;
  }
}

const sortedRecordings = computed(() => {
  const copy = [...recordings.value];
  copy.sort(compareRecordings);
  return copy;
});

onMounted(async () => {
  try {
    await api.listRecordings();
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

.toolbar-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
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

.sort-select {
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

.sort-select:hover {
  border-color: var(--fluoro);
  color: var(--fluoro);
  box-shadow: 2px 2px 0 var(--ink);
  transform: translate(-1px, -1px);
}

.sort-select:focus {
  outline: none;
  border-color: var(--fluoro);
  color: var(--fluoro);
}

.sort-select option {
  background: var(--paper);
  color: var(--ink);
}

@keyframes pulse {
  0%,100% { opacity:1; transform:scale(1); }
  50% { opacity:.35; transform:scale(.7); }
}
</style>
