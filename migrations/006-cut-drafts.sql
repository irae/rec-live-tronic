CREATE TABLE cut_drafts (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('trim', 'split')),
  params TEXT NOT NULL,
  working_dir TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('previewing', 'promoted', 'failed')),
  piece_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX cut_drafts_active_source_idx ON cut_drafts(source_id) WHERE status = 'previewing';
