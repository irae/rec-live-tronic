# Frontend Architecture — the web client

This guide explains how the web client is organized and which conventions to
follow when changing it. It assumes you know general programming but not this
app, and possibly not Vue. The backend is out of scope here; see `spec.md` for
that side.

## The big picture

The client is a single-page application (SPA) built with Vue 3 and bundled by
Vite. There is no separate frontend server in production: `npm run build`
compiles the client into static files that the same Express API serves at `/`.
The client talks to the API with plain `fetch` calls against relative URLs, so
it works identically whether Vite's dev server is proxying to a local backend
or the built files are served by the API itself.

Everything lives under `web-client/src`. The entry point creates one Vue app,
installs the router, and mounts it into the single `index.html` page. From
that moment on, all "page" changes are client-side: the router swaps
components in and out without full page loads.

## Vue in two minutes, as used here

Every UI unit is a Single File Component (SFC): a `.vue` file with three
sections — `<template>` (the HTML), `<script setup lang="ts">` (the logic,
TypeScript), and `<style scoped>` (CSS that applies only to this component).

All components use the Composition API with `<script setup>`. That means the
script body runs once when the component is created, and everything it
declares (variables, functions) is directly usable in the template. The
reactivity primitives to know:

- `ref(x)` creates a reactive box around a value; read/write it as `.value`
  in scripts, but plain (no `.value`) in templates. When it changes, any
  template or computed using it re-renders automatically.
- `reactive(obj)` makes an object deeply reactive (used for form models).
- `computed(fn)` derives a value from other reactive state and stays in sync.
- `watch(source, fn)` runs a callback when reactive state changes.
- `onMounted`/`onUnmounted` are lifecycle hooks — code to run when the
  component appears in / leaves the DOM (e.g. starting and stopping a poll).

A key property this app leans on: a `ref` exported from a plain module is
shared, live state. Any component that imports it sees every change
immediately, because Vue's reactivity is attached to the ref itself, not to
the component. That is the entire state-management story here — deliberately
so. There is no Pinia/Vuex store and none should be introduced.

## Routing

`vue-router` in HTML5 history mode provides four routes: the Archive (`/`,
finished recordings), Schedule (`/schedule`), per-recording detail
(`/watch/:id` — deliberately not `/recordings/:id`, which the JSON API owns),
and Trash (`/trash`). Each route maps to a view component and a document
title, set by a small navigation hook. The Express server has an SPA-fallback
route so a deep link or refresh on any client route still serves `index.html`.

## Shared state: the api.ts pattern

All server communication and all shared client state live in one module,
`api.ts`. It exports:

- an `api` object (an `ApiClient` instance) with one method per backend
  endpoint — list, create, patch, cancel, trash, restore, cut, and so on;
- shared refs: `recordings` (every non-trashed recording), `trashedRecordings`
  (the trash bin), `diskSpace` and `isRecording` (header figures).

The rule that keeps every screen in sync: **mutating API methods update the
shared refs themselves, as part of succeeding.** Patching a recording replaces
its entry in the shared list; creating one inserts it; deleting one moves it
from `recordings` to `trashedRecordings`; restoring moves it back; a cut
"Keep" adds the new pieces and moves the source to trash. Views never patch
the shared lists after an action — they call the `api` method, show a toast,
maybe navigate, and trust the shared state to already be correct everywhere.

Views are therefore plain consumers: they `import { recordings } from
"../api"` and derive what they need with `computed` filters (Archive shows
`status === "recorded"`, Schedule shows scheduled/recording, Trash reads the
trash ref). Because the refs are module-level, an action taken on one screen
is instantly visible on any other screen that renders from them.

Polling exists only as a staleness safety net, not as the way the UI learns
about its own actions. The root component runs one global 60-second poll of
the full recordings list, which also refreshes the disk-space and
is-recording figures carried on every list response. The Trash view runs its
own separate poll for the trashed set — a deliberate decision, since trashed
and non-trashed are disjoint server-side queries — but cross-list moves still
update both refs immediately through the api.ts side effects. The polls catch
changes made outside the app (chiefly the reconciler flipping statuses as
recordings start and finish).

When you add a new mutating endpoint, put its shared-state side effect inside
the `ApiClient` method, next to the fetch. Do not "fix" a stale screen by
adding a refetch or a manual list splice in a view — that is the exact
inconsistency this layer exists to prevent.

## Views, components, composables, lib

Four folders, four roles:

- `views/` — one component per route. They own page-level layout and the
  page's actions, and read shared state as described above.
- `components/` — reusable pieces mounted by views or the root component: the
  recording list, the confirm dialog, the toast host, and the cut console
  (the mark/preview/keep UI on the detail page — the one component with
  substantial state of its own, all of it local to an in-progress cut draft).
- `composables/` — shared logic exposed as a `useX()` function. `useToast`
  keeps a module-level list of toast messages; any component calls
  `toast("...")` and the single `ToastHost` mounted in the root renders and
  auto-dismisses them. New cross-cutting UI behaviors belong here, following
  the same shape.
- `lib/` — plain TypeScript helpers with no Vue in them: building file URLs
  with friendly filenames, VLC deep links and platform detection,
  clipboard copy with a non-HTTPS fallback, and cut-offset parsing/formatting.
  Some mirror a server-side counterpart; the server always re-validates and
  stays the source of truth.

Component state stays local (a `ref` inside the component) unless more than
one screen needs it — then it belongs in api.ts. Per-page concerns like
"which row is being edited" or form contents never go in shared state.

## Conventions worth knowing

- **Playback**: finished recordings are MPEG-TS files, which no browser plays
  natively; the detail view feeds them through `mpegts.js` (MSE-based
  transmuxing) into a `<video>` element, falling back to a plain `src` where
  MSE is unavailable. See `docs/browser-playback-research.md` for why.
- **Errors**: catch, `console.error` the real error, then surface a friendly
  message — a toast or an inline error ref. Never swallow errors silently.
- **Optimistic-but-honest updates**: shared-state updates happen after the
  request succeeds, not before. There is no rollback machinery because
  nothing is applied until the server said yes.
- **Styling**: no CSS framework. Global design tokens (colors, fonts, shadows,
  spacing) are CSS custom properties defined once in the root component's
  unscoped style block; every component styles itself in `<style scoped>`
  using those variables. Fonts load from Google Fonts. Reuse the variables
  rather than hardcoding colors.
- **Times**: the API speaks ISO 8601 UTC strings; views convert to local time
  at the edge, for display and for `datetime-local` inputs.
- **TypeScript**: the API client declares interfaces for server payloads
  (camelCase, already translated by the server from snake_case columns).
  There is no separate client typecheck step in the build — Vite only strips
  types — so keep an editor with Vue language support handy.

## Developing and verifying

Run the backend (`npm run build` then `npm start` with the `.local` env vars —
see `AGENTS.md`), then `npm run dev:client` for Vite's dev server on port 5173
with hot reload and an API proxy. There is no frontend test suite; the
convention for UI changes is to verify live in a real browser (the repo's
agents use the Playwright CLI for this). The backend suite (`npm test`) should
stay green and untouched by client-only work.

## Where to look

- App entry and mounting: `web-client/src/main.ts`
- Routes: `web-client/src/router.ts`
- Shared state and all API calls: `web-client/src/api.ts`
- Root layout, global poll, design tokens: `web-client/src/App.vue`
- Route views: `web-client/src/views/`
- Reusable components: `web-client/src/components/`
- Toasts: `web-client/src/composables/useToast.ts`
- Vue-free helpers: `web-client/src/lib/`
- Build/proxy config: `vite.config.ts`
