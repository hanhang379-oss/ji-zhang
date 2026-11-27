CREATE TABLE tx_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id INTEGER NOT NULL REFERENCES transactions(id),
  blob_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX tx_images_tx_id_idx ON tx_images (tx_id);
