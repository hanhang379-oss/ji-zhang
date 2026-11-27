import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import * as schema from "./schema";

const imageShape = z.object({
  id: z.number(),
  url: z.string(),
});

const txShape = z.object({
  id: z.number(),
  kind: z.enum(["income", "expense"]),
  amount_cents: z.number(),
  category: z.string(),
  note: z.string(),
  occurred_on: z.string(),
  images: z.array(imageShape),
});

type TxRow = typeof schema.transactions.$inferSelect;

/** First day of the month after `month` (YYYY-MM), for range queries. */
function nextMonth(month: string): string {
  const [y = 1970, m = 1] = month.split("-").map(Number);
  const d = new Date(y, m, 1); // m is 1-indexed here: Date month m = next month
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}-01`;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Load one transaction's images (with renderable URLs) in upload order. */
async function loadImages(
  ctx: Ctx,
  txId: number,
): Promise<z.infer<typeof imageShape>[]> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.txImages)
    .where(eq(schema.txImages.txId, txId))
    .orderBy(asc(schema.txImages.id));
  const out: z.infer<typeof imageShape>[] = [];
  for (const row of rows) {
    out.push({ id: row.id, url: await ctx.blobs.getUrl(row.blobKey) });
  }
  return out;
}

async function toTx(
  ctx: Ctx,
  row: TxRow,
): Promise<z.infer<typeof txShape>> {
  return {
    id: row.id,
    kind: row.kind,
    amount_cents: row.amountCents,
    category: row.category,
    note: row.note,
    occurred_on: row.occurredOn,
    images: await loadImages(ctx, row.id),
  };
}

const monthRe = /^\d{4}-\d{2}$/;
const dayRe = /^\d{4}-\d{2}-\d{2}$/;

const txInput = {
  kind: z.enum(["income", "expense"]),
  amount_cents: z
    .number()
    .int()
    .positive("金额要大于 0")
    .max(100_000_000_00, "金额太大了"),
  category: z.string().trim().min(1, "选个分类").max(20),
  note: z.string().trim().max(60).default(""),
  occurred_on: z.string().regex(dayRe, "日期格式不对"),
};

const okResponse = z.object({ ok: z.literal(true) });

export const Actions = {
  getMonth: defineAction({
    description:
      "Returns one month's transactions (newest first, each with its photo evidence) plus total money received from the teacher, total spent, and the totals in cents.",
    request: z.object({
      month: z.string().regex(monthRe, "月份格式不对"),
    }),
    response: z.object({
      transactions: z.array(txShape),
      income_cents: z.number(),
      expense_cents: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const from = `${args.month}-01`;
      const to = nextMonth(args.month);
      const rows = await db
        .select()
        .from(schema.transactions)
        .where(
          and(
            gte(schema.transactions.occurredOn, from),
            lt(schema.transactions.occurredOn, to),
          ),
        )
        .orderBy(
          desc(schema.transactions.occurredOn),
          desc(schema.transactions.id),
        );
      let income = 0;
      let expense = 0;
      for (const row of rows) {
        if (row.kind === "income") income += row.amountCents;
        else expense += row.amountCents;
      }
      const transactions: z.infer<typeof txShape>[] = [];
      for (const row of rows) transactions.push(await toTx(ctx, row));
      return {
        transactions,
        income_cents: income,
        expense_cents: expense,
      };
    },
  }),

  getYear: defineAction({
    description:
      "Returns one full year's transactions (newest first, each with its photo evidence) plus total money received from the teacher, total spent, and the totals in cents. Used for the annual statement export.",
    request: z.object({
      year: z.string().regex(/^\d{4}$/, "年份格式不对"),
    }),
    response: z.object({
      transactions: z.array(txShape),
      income_cents: z.number(),
      expense_cents: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const from = `${args.year}-01-01`;
      const to = `${Number(args.year) + 1}-01-01`;
      const rows = await db
        .select()
        .from(schema.transactions)
        .where(
          and(
            gte(schema.transactions.occurredOn, from),
            lt(schema.transactions.occurredOn, to),
          ),
        )
        .orderBy(
          desc(schema.transactions.occurredOn),
          desc(schema.transactions.id),
        );
      let income = 0;
      let expense = 0;
      for (const row of rows) {
        if (row.kind === "income") income += row.amountCents;
        else expense += row.amountCents;
      }
      const transactions: z.infer<typeof txShape>[] = [];
      for (const row of rows) transactions.push(await toTx(ctx, row));
      return {
        transactions,
        income_cents: income,
        expense_cents: expense,
      };
    },
  }),

  addTransaction: defineAction({
    description:
      "Adds one record: money received from the teacher, or money spent. Returns its id.",
    request: z.object(txInput),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.transactions)
        .values({
          kind: args.kind,
          amountCents: args.amount_cents,
          category: args.category,
          note: args.note,
          occurredOn: args.occurred_on,
        })
        .returning({ id: schema.transactions.id });
      const inserted = result[0];
      if (!inserted) throw new Error("记账失败，请重试");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  updateTransaction: defineAction({
    description: "Updates an existing record's fields.",
    request: z.object({ id: z.number().int().positive(), ...txInput }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const result = await db
        .update(schema.transactions)
        .set({
          kind: args.kind,
          amountCents: args.amount_cents,
          category: args.category,
          note: args.note,
          occurredOn: args.occurred_on,
        })
        .where(eq(schema.transactions.id, args.id))
        .returning({ id: schema.transactions.id });
      if (!result[0]) throw new Error("这笔账找不到了");
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteTransaction: defineAction({
    description:
      "Deletes one record together with all its attached photo evidence.",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const images = await db
        .select()
        .from(schema.txImages)
        .where(eq(schema.txImages.txId, args.id));
      for (const img of images) {
        await ctx.blobs.delete(img.blobKey).catch(() => undefined);
      }
      if (images.length > 0) {
        await db
          .delete(schema.txImages)
          .where(eq(schema.txImages.txId, args.id));
      }
      await db
        .delete(schema.transactions)
        .where(eq(schema.transactions.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  addImage: defineAction({
    description:
      "Attaches one photo (receipt, invoice, or what the money bought) to a record and returns the stored image.",
    request: z.object({
      tx_id: z.number().int().positive(),
      image: z.object({
        dataBase64: z.string().min(1).max(14_000_000),
        mimeType: z.enum(["image/jpeg", "image/png"]),
      }),
    }),
    response: imageShape,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const tx = await db
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, args.tx_id));
      if (!tx[0]) throw new Error("这笔账找不到了");
      const existing = await db
        .select({ id: schema.txImages.id })
        .from(schema.txImages)
        .where(eq(schema.txImages.txId, args.tx_id));
      if (existing.length >= 9) throw new Error("一笔最多留 9 张照片");
      const ext = args.image.mimeType === "image/png" ? "png" : "jpg";
      const blobKey = `tx/${args.tx_id}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}.${ext}`;
      await ctx.blobs.put(blobKey, base64ToBytes(args.image.dataBase64), {
        contentType: args.image.mimeType,
      });
      const inserted = await db
        .insert(schema.txImages)
        .values({ txId: args.tx_id, blobKey })
        .returning({ id: schema.txImages.id });
      const row = inserted[0];
      if (!row) throw new Error("照片保存失败，请重试");
      ctx.invalidateQueries();
      return { id: row.id, url: await ctx.blobs.getUrl(blobKey) };
    },
  }),

  deleteImage: defineAction({
    description: "Removes one attached photo from a record.",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.txImages)
        .where(eq(schema.txImages.id, args.id));
      const row = rows[0];
      if (row) {
        await ctx.blobs.delete(row.blobKey).catch(() => undefined);
        await db
          .delete(schema.txImages)
          .where(eq(schema.txImages.id, args.id));
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
