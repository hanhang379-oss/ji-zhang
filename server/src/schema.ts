import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["income", "expense"] }).notNull(),
  /** Amount in cents (fen) to keep money math exact. */
  amountCents: integer("amount_cents").notNull(),
  category: text("category").notNull(),
  note: text("note").notNull().default(""),
  /** Local calendar day the money moved, YYYY-MM-DD. */
  occurredOn: text("occurred_on").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Photo evidence attached to a transaction (receipt, invoice, the item bought…). */
export const txImages = sqliteTable("tx_images", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  txId: integer("tx_id")
    .notNull()
    .references(() => transactions.id),
  /** Key of the image bytes in ctx.blobs storage. */
  blobKey: text("blob_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
