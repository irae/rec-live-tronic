# Trim/Split Edit Workflow — Design Sketch

> **Status: design sketch, not a plan.** This document organizes the owner's
> verbally-described design for the trim/split editing flow so a planner can turn
> it into a real Phase 5 plan. It deliberately does **not** invent endpoint paths,
> payload shapes, table names, column names, or UI labels — naming is explicitly
> the next agent's job (see "Open questions for the planner"). Where the owner gave
> a literal instruction, it is recorded verbatim and flagged; where it conflicts
> with an existing repo decision, the conflict is surfaced as a question rather
> than silently resolved.

## Why this exists (link to the research)

The trim/split preview research (`docs/trim-preview-research.md`) settled the
"how do we cut" question: a raw byte-range slice of the existing `.ts` is feasible
but **strictly dominated** by a plain `ffmpeg -ss … -to … -c copy` extraction —
same near-instant cost (~0.036 s for a 10 s range in local testing), but a clean
decode and near-zero output timestamps instead of boundary glitches and an
unresettable ~31 s PTS offset. So every cut in this workflow is an `ffmpeg -c copy`
job, never a hand-rolled byte slice. That research also confirmed `mpegts.js`
(already a dependency) does keyframe-accurate, byte-offset client-side seeking
against the existing range-enabled `GET /recordings/:id/file` route, which is what
makes step 1's client-side mark-picking cheap.

This sketch takes that verdict as given and reworks the trim/split **flow** around
it: a **preview-then-promote** model, materially different from the direct
derived-row model currently written in `plan.md` Phase 5 (see "How this changes the
existing Phase 5 plan" at the end).

## Core idea: one mechanism, two configurations

Per the owner's own framing — *"All actions can be derived or built on top of this
idea"* — **trim and split are not two mechanisms; they are two configurations of one
mechanism.** The underlying operation is: take a source recording, a set of cut
points chosen client-side, run `ffmpeg -c copy` to produce one or more output
files, preview them, and on approval promote them to first-class recordings.

- **Split** = multiple cut points → N+1 output pieces → N+1 preview players.
- **Trim** = a single kept range, expressed as one mark ("mark start" only, or
  "mark start" + "mark end") → exactly **one** output file → one preview player.

"Preview" in the trim case produces only that single trimmed-range file in the
working folder, not multiple. Everything else in the flow below is identical.

## The flow

### 1. Client picks the cut point(s) and posts timestamp(s)

- The user selects split/trim point(s) in the browser player, driven **only by
  `mpegts.js`'s public, documented APIs** (current playback time / keyframe info —
  whatever is simplest and most maintainable). **No private/internal APIs.**
- The client posts the chosen timestamp(s) to a server endpoint (a single mark or a
  start+end for trim; an ordered list of cut points for split). Concrete endpoint
  path and payload shape are left to the planner (see "Open questions").

### 2. Server creates a per-edit working folder

- **Literal owner instruction (recorded precisely):** the server creates a working
  directory/folder **named after the source recording's file basename without its
  extension** — e.g. source `rec-<id>.ts` → a `rec-<id>/` folder — to hold the
  edit's output file(s).
- **⚠ Conflicts with the current on-disk layout — flagged, not resolved here.**
  This repo currently stores recordings **flat**: every recording's file is
  `join(recordingsDir, `${id}.ts`)` (`src/api/service.ts` builds `ts_path` exactly
  this way; there is no per-recording subdirectory today). A `rec-<id>/` folder
  sitting next to `rec-<id>.ts` in the same `recordingsDir`, or replacing the flat
  file with a folder, is a departure from that convention. Whether the per-edit
  folder lives under `recordingsDir`, under a separate scratch/edits directory, or
  whether the flat layout should change at all, is an open question for the planner
  (see "Open questions", item a).

### 3. Server runs `ffmpeg -c copy` into the working folder

- The server runs the `ffmpeg -c copy` extraction(s) — one per output piece — into
  the per-edit folder from step 2, and returns a reference to the produced file(s)
  to the client.
- The output is the same clean, near-zero-PTS extraction the research validated —
  identical to the ffmpeg invocation the real cut would run, because in this flow
  the preview artifact *is* the future promoted file (no throwaway second render).
- **Open: statelessness vs. an edits-tracking table.** The owner is explicitly
  unsure whether this step needs to be stateless or backed by a new SQL table (e.g.
  an "edits" table) to track in-progress / abandoned edits so their working folders
  can be cleaned up later. This is called out as an open design question for the
  planner to decide, not resolved here (see "Open questions", item b).

### 4. Client renders preview players; original player is kept alive but collapsed

- The server response gives the client enough to render **preview players for the
  produced piece(s)** — e.g. two players for a two-way split, one player for a trim.
- The **original player is not destroyed** — it is visually collapsed but kept in
  the DOM. The owner's own suggested approach is CSS such as `height: 0; overflow:
  hidden;` (or similar), keeping the original player alive rather than tearing it
  down — presumably to preserve player state and avoid re-buffering if the user
  backs out.
- The user reviews the previews and can **Undo / cancel** at this point. On cancel,
  nothing is promoted; the working folder's output(s) are abandoned (cleanup of
  abandoned edits is the crux of the stateless-vs-edits-table question in step 3).

### 5. On approval, promote the piece(s) to first-class recordings

- Once the user approves, the produced slice(s) are **promoted** to real, first-class
  recording rows — **indistinguishable from a recording captured live via
  streamlink** — listed, served, played, and themselves re-trimmable/re-splittable
  through the existing routes like any other recording.
- **Except:** each promoted row carries a **new property linking back to the
  edit/source it was derived from**, so the relationship can be inspected or reverted
  later. (The property is unnamed here on purpose — naming is the next agent's job.)
- The owner named possible **future** UI built on this linkage as *ideas, not
  commitments*: "see original", "revert", "originated from". These are noted for the
  planner's awareness, not scoped into this workflow.

## Storage guideline (not a hard rule)

The owner asked that storage avoid moving/relocating existing files where possible —
*"things don't move on the storage, etc if possible"* — but explicitly called this
**a guideline, not a hard restriction.** It should bias implementation toward leaving
the source `.ts` in place and writing only new output, but it must **not** be treated
as an absolute constraint that blocks a reasonable implementation choice if something
genuinely needs to move. (The stronger, non-negotiable invariant remains the one
Phase 5 already states: the *source* recording's file is never modified or deleted by
an edit — non-destructiveness of the source is a hard rule; avoiding all other file
movement is the soft guideline.)

## Open questions for the planner

These are explicitly deferred — this sketch surfaces them, the planner decides them.

a. **Per-edit working folder vs. the existing flat layout.** The owner's `rec-<id>/`
   folder (step 2) conflicts with the current flat `join(recordingsDir, `${id}.ts`)`
   layout. Does it need reconciling — a per-recording subdirectory scheme, a separate
   edits/scratch directory, or keeping flat and deriving output names some other way?
   Decide before building; don't silently accept or reject the folder instruction.

b. **Stateless vs. an "edits" tracking table.** Does step 3/4 need durable state to
   track in-progress and abandoned edits (so orphaned working folders get cleaned up),
   or can the flow be stateless with cleanup handled some other way? The owner is
   undecided; this is a genuine design fork, not a detail.

c. **Exact promotion semantics.** Step 5 says a promoted derived recording should be
   "exactly the same as recorded live." What does that mean **precisely** for each
   field on the `recordings` row? Concretely: what are `start_at` / `stop_at` on a
   piece that was cut out of a longer capture (the sub-range's real wall-clock times?
   the source's? null?); what `status` does a promoted piece land in (`recorded`?
   `muxed`?); does it inherit the source's `stage`, `title`, `url`, `cookie_id`,
   `quality`? And how does the "linking property" (step 5) coexist with
   "indistinguishable from a live capture"? These need spelling out against the
   `recordings` data model in `spec.md`.

d. **Naming — all of it.** The owner has named nothing here: not the endpoint(s), not
   the working-folder scheme, not any new table or column, not the linking property,
   not the UI labels ("see original" / "revert" / "originated from" are illustrative
   ideas, not chosen strings). Naming is explicitly a **separate design/naming pass**,
   the next agent's job — not something this sketch or the mechanism plan should
   improvise. It should stay consistent with this repo's curl-first API conventions
   (`spec.md` "API surface (curl-first)") when it happens.

## How this changes the existing Phase 5 plan

`plan.md`'s current Phase 5 describes trim/split as producing derived recording rows
**directly** — `POST /recordings/:id/trim` (and `/split`) immediately create the new
derived row(s) and run the `ffmpeg -c copy` job, with the result landing `recorded`
on success. There is **no preview/approve/promote intermediate step** in what is
written there today; its research-and-review gate on "preview before confirm" is still
open, and its own recommendation leaned toward *no dedicated preview mechanism* (rely
on trash-and-redo plus free client-side scrubbing).

**This sketch is a materially different flow.** It inserts an explicit
**preview-then-promote** two-step: the cut is produced first as a reviewable preview
artifact in a per-edit working folder, the original player is kept alive but collapsed,
and only on the user's approval does the piece become a first-class recording row
(carrying a link back to its source). That is not a refinement of the current Phase 5
text — it changes when the derived row comes into existence (after approval, not at
job submission) and adds working-folder and possible edits-tracking machinery the
current plan does not describe.

This document does **not** edit `plan.md`. Reconciling the two — and deciding the open
questions above — is the planner's task in the next step. Note also that the current
Phase 5 text still carries an unresolved owner-framing flag on split semantics
("record becomes two records… keep one of the IDs" vs. all-new source-preserving rows);
the promotion semantics in open question (c) should be settled together with that.
