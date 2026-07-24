ALTER TABLE recordings ADD COLUMN cut_from_id TEXT REFERENCES recordings(id) ON DELETE SET NULL;
