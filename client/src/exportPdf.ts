/**
 * Builds the monthly statement PDF in the browser, in the same shape as the
 * statement han already uses: page 1 is the summary + numbered detail table
 * (date, what was bought, category, amount) + category totals, and the photo
 * evidence follows on its own pages, grouped by transaction: one label with
 * the detail-table number per item, then all of that item's photos together
 * in uniform frames at their original aspect ratio.
 *
 * Pages are drawn on canvases (so Chinese text renders with the device's own
 * fonts) and each canvas is embedded as a full-page JPEG in a hand-assembled
 * PDF — no external PDF library needed.
 */

export interface ExportTx {
  id: number;
  kind: "income" | "expense";
  amount_cents: number;
  category: string;
  note: string;
  occurred_on: string;
  images: { id: number; url: string }[];
}

const PW = 595.28; // A4 width, pt
const PH = 841.89; // A4 height, pt
const SCALE = 2; // render at 2x so the embedded pages stay sharp
const MX = 48; // side margin
const CW = PW - MX * 2; // content width
const TOP = 44;
const BOTTOM = PH - 52; // lowest y content may reach (footer sits below)

const FONT =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const INK = "#1f2a36";
const DIM = "#68727d";
const BORDER = "#c2cdd8";
const HEADER_BG = "#2e3d4e";
const LIGHT_BG = "#edf1f5";
const ZEBRA = "#f6f8fa";
const INCOME = "#166e5a";
const EXPENSE = "#b3402e";

/** cents -> "30.00" */
function yuan(cents: number): string {
  return (Math.abs(cents) / 100).toFixed(2);
}

/** cents -> "¥281.44" / "-¥281.44" */
function yuanWithSymbol(cents: number): string {
  return `${cents < 0 ? "-" : ""}¥${yuan(cents)}`;
}

/** "2026-10-10" -> "10月10日" */
function dayLabel(iso: string): string {
  const [, m = "1", d = "1"] = iso.split("-");
  return `${Number(m)}月${Number(d)}日`;
}

/** "2026-10-10" -> "2026年10月10日" */
function fullDayLabel(iso: string): string {
  const [y = "", m = "1", d = "1"] = iso.split("-");
  return `${y}年${Number(m)}月${Number(d)}日`;
}

type Bitmap = ImageBitmap | HTMLImageElement;

async function loadBitmap(url: string): Promise<Bitmap | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    try {
      return await createImageBitmap(blob);
    } catch {
      const objUrl = URL.createObjectURL(blob);
      try {
        return await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("image decode failed"));
          img.src = objUrl;
        });
      } finally {
        // The bitmap keeps its own reference once loaded; revoke is safe
        // after load for <img> in practice, but keep the URL alive by not
        // revoking — these exports are short-lived pages anyway.
      }
    }
  } catch {
    return null;
  }
}

function bitmapSize(b: Bitmap): { w: number; h: number } {
  return b instanceof HTMLImageElement
    ? { w: b.naturalWidth, h: b.naturalHeight }
    : { w: b.width, h: b.height };
}

interface Page {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  y: number;
}

class PdfRenderer {
  pages: Page[] = [];
  private titleLine: string;

  constructor(titleLine: string) {
    this.titleLine = titleLine;
    this.newPage();
  }

  get page(): Page {
    const p = this.pages[this.pages.length - 1];
    if (!p) throw new Error("no page");
    return p;
  }

  newPage(): void {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(PW * SCALE);
    canvas.height = Math.round(PH * SCALE);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, PW, PH);
    ctx.textBaseline = "alphabetic";
    const page: Page = { canvas, ctx, y: TOP };
    this.pages.push(page);
    // Footer, same as the reference statement.
    this.text(this.titleLine, MX, PH - 24, { size: 8, color: "#8a94a0" });
    const label = `第 ${this.pages.length} 页`;
    this.text(label, PW - MX, PH - 24, {
      size: 8,
      color: "#8a94a0",
      align: "right",
    });
  }

  text(
    str: string,
    x: number,
    y: number,
    opts: {
      size?: number;
      bold?: boolean;
      color?: string;
      align?: CanvasTextAlign;
    } = {},
  ): void {
    const { ctx } = this.page;
    ctx.font = `${opts.bold ? "700" : "400"} ${opts.size ?? 10}px ${FONT}`;
    ctx.fillStyle = opts.color ?? INK;
    ctx.textAlign = opts.align ?? "left";
    ctx.fillText(str, x, y);
    ctx.textAlign = "left";
  }

  /** Truncate with … until the text fits maxWidth at the given size. */
  fit(str: string, maxWidth: number, size: number, bold = false): string {
    const { ctx } = this.page;
    ctx.font = `${bold ? "700" : "400"} ${size}px ${FONT}`;
    if (ctx.measureText(str).width <= maxWidth) return str;
    let s = str;
    while (s.length > 0 && ctx.measureText(`${s}…`).width > maxWidth) {
      s = s.slice(0, -1);
    }
    return `${s}…`;
  }

  ensure(height: number): void {
    if (this.page.y + height > BOTTOM) this.newPage();
  }

  sectionTitle(str: string): void {
    this.ensure(30);
    const p = this.page;
    this.text(str, MX, p.y + 14, { size: 13.5, bold: true });
    p.y += 27;
  }

  /** One table row's frame: background, bottom line, vertical separators. */
  rowFrame(
    y: number,
    h: number,
    colEdges: number[],
    fill?: string,
  ): void {
    const { ctx } = this.page;
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(MX, y, CW, h);
    }
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(MX, y + h);
    ctx.lineTo(MX + CW, y + h);
    for (const x of colEdges) {
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + h);
    }
    ctx.stroke();
    // Outer sides + top handled by caller drawing the table outline.
  }

  tableOutline(y: number, h: number): void {
    const { ctx } = this.page;
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 0.7;
    ctx.strokeRect(MX, y, CW, h);
  }
}

interface PhotoGroup {
  label: string;
  bitmaps: (Bitmap | null)[];
}

export async function buildStatementPdf(args: {
  month: string; // YYYY-MM
  monthTitle: string; // e.g. 2026年10月
  transactions: ExportTx[];
  income_cents: number;
  expense_cents: number;
}): Promise<Blob> {
  const { monthTitle } = args;
  const balance = args.income_cents - args.expense_cents;

  // Chronological order (oldest first), numbered Z001… like the reference.
  const ordered = [...args.transactions].sort((a, b) =>
    a.occurred_on === b.occurred_on
      ? a.id - b.id
      : a.occurred_on < b.occurred_on
        ? -1
        : 1,
  );
  const codeOf = new Map<number, string>();
  ordered.forEach((tx, i) => {
    codeOf.set(tx.id, `Z${String(i + 1).padStart(3, "0")}`);
  });
  const itemOf = (tx: ExportTx) => tx.note.trim() || tx.category;

  // Load every photo up front so page layout never waits mid-draw.
  // Group by transaction: one label/number per item, all its photos together.
  const photoGroups: PhotoGroup[] = [];
  for (const tx of ordered) {
    if (tx.images.length === 0) continue;
    const bitmaps: (Bitmap | null)[] = [];
    for (const img of tx.images) {
      bitmaps.push(await loadBitmap(img.url));
    }
    photoGroups.push({
      label: `凭证 ${photoGroups.length + 1} · ${codeOf.get(tx.id) ?? ""} ${dayLabel(tx.occurred_on)} ${itemOf(tx)} ${yuanWithSymbol(tx.kind === "income" ? tx.amount_cents : -tx.amount_cents)}`,
      bitmaps,
    });
  }

  const r = new PdfRenderer(`${monthTitle}收支账单｜金额单位：人民币元`);

  // ---- Title block (first page only) ----
  {
    const p = r.page;
    r.text(`${monthTitle}收支账单`, PW / 2, p.y + 20, {
      size: 20,
      bold: true,
      align: "center",
    });
    p.y += 34;
    const startIso = ordered[0]?.occurred_on ?? `${args.month}-01`;
    r.text(
      `记账币种：人民币（CNY） | 账单起始日期：${fullDayLabel(startIso)}`,
      PW / 2,
      p.y + 10,
      { size: 9, color: DIM, align: "center" },
    );
    p.y += 26;
  }

  // ---- 一、收支汇总 ----
  r.sectionTitle("一、收支汇总");
  {
    const p = r.page;
    const colW = CW / 3;
    const edges = [MX + colW, MX + colW * 2];
    const headerY = p.y;
    r.rowFrame(headerY, 24, edges, LIGHT_BG);
    const labels = ["累计收入", "累计支出", "当前结余"];
    labels.forEach((label, i) => {
      r.text(label, MX + colW * i + colW / 2, headerY + 16, {
        size: 10,
        bold: true,
        color: "#44505c",
        align: "center",
      });
    });
    const valueY = headerY + 24;
    r.rowFrame(valueY, 32, edges);
    const values = [
      yuanWithSymbol(args.income_cents),
      yuanWithSymbol(args.expense_cents),
      yuanWithSymbol(balance),
    ];
    values.forEach((v, i) => {
      r.text(v, MX + colW * i + colW / 2, valueY + 21, {
        size: 13,
        bold: true,
        color: i === 2 && balance < 0 ? EXPENSE : INK,
        align: "center",
      });
    });
    r.tableOutline(headerY, 56);
    p.y = valueY + 32 + 14;
  }

  // ---- 二、收支明细 ----
  const hasIncome = ordered.some((tx) => tx.kind === "income");
  r.sectionTitle(hasIncome ? "二、收支明细" : "二、消费明细");
  {
    // Columns: 编号 42 | 日期 66 | 项目 flex | 类别 92 | 金额 78
    const edges = [
      MX + 42,
      MX + 42 + 66,
      MX + CW - 78 - 92,
      MX + CW - 78,
    ];
    const headerH = 24;
    const rowH = 23;
    const drawHeader = () => {
      r.ensure(headerH);
      const p = r.page;
      const y = p.y;
      r.rowFrame(y, headerH, edges, HEADER_BG);
      const heads: { str: string; x: number; align?: CanvasTextAlign }[] = [
        { str: "编号", x: MX + 6 },
        { str: "日期", x: MX + 42 + 6 },
        { str: "消费项目", x: MX + 42 + 66 + 6 },
        { str: "类别", x: MX + CW - 78 - 92 + 6 },
        { str: "金额（元）", x: MX + CW - 6, align: "right" },
      ];
      for (const h of heads) {
        r.text(h.str, h.x, y + 16, {
          size: 10,
          bold: true,
          color: "#ffffff",
          align: h.align,
        });
      }
      p.y += headerH;
    };
    drawHeader();
    if (ordered.length === 0) {
      r.ensure(rowH);
      const p = r.page;
      r.rowFrame(p.y, rowH, edges);
      r.text("本月暂无记录", MX + 6, p.y + 15, { size: 10, color: DIM });
      p.y += rowH;
    }
    ordered.forEach((tx, i) => {
      if (r.page.y + rowH > BOTTOM) {
        r.newPage();
        drawHeader();
      }
      const p = r.page;
      const y = p.y;
      r.rowFrame(y, rowH, edges, i % 2 === 1 ? ZEBRA : undefined);
      const base = y + 15;
      r.text(codeOf.get(tx.id) ?? "", MX + 6, base, {
        size: 10,
        color: "#55606a",
      });
      r.text(dayLabel(tx.occurred_on), MX + 42 + 6, base, { size: 10 });
      const itemMax = CW - 78 - 92 - (42 + 66) - 12;
      r.text(r.fit(itemOf(tx), itemMax, 10), MX + 42 + 66 + 6, base, {
        size: 10,
      });
      const catMax = 92 - 12;
      r.text(
        r.fit(tx.category, catMax, 10),
        MX + CW - 78 - 92 + 6,
        base,
        { size: 10 },
      );
      const amount =
        tx.kind === "income" ? `+${yuan(tx.amount_cents)}` : yuan(tx.amount_cents);
      r.text(amount, MX + CW - 6, base, {
        size: 10,
        align: "right",
        color: tx.kind === "income" ? INCOME : INK,
      });
      p.y += rowH;
    });
    r.page.y += 14;
  }

  // ---- 三、分类汇总 ----
  r.sectionTitle("三、分类汇总");
  {
    const useIncome = args.expense_cents === 0 && args.income_cents > 0;
    const kind = useIncome ? "income" : "expense";
    const map = new Map<string, number>();
    for (const tx of ordered) {
      if (tx.kind !== kind) continue;
      map.set(tx.category, (map.get(tx.category) ?? 0) + tx.amount_cents);
    }
    const rows = [...map.entries()]
      .map(([category, cents]) => ({ category, cents }))
      .sort((a, b) => b.cents - a.cents);
    const total = useIncome ? args.income_cents : args.expense_cents;
    const edges = [MX + CW - 110];
    const headerH = 24;
    const rowH = 23;
    r.ensure(headerH);
    {
      const p = r.page;
      const y = p.y;
      r.rowFrame(y, headerH, edges, LIGHT_BG);
      r.text("类别", MX + 6, y + 16, {
        size: 10,
        bold: true,
        color: "#44505c",
      });
      r.text("金额（元）", MX + CW - 6, y + 16, {
        size: 10,
        bold: true,
        color: "#44505c",
        align: "right",
      });
      p.y += headerH;
    }
    if (rows.length === 0) {
      r.ensure(rowH);
      const p = r.page;
      r.rowFrame(p.y, rowH, edges);
      r.text("暂无", MX + 6, p.y + 15, { size: 10, color: DIM });
      p.y += rowH;
    }
    rows.forEach((row, i) => {
      r.ensure(rowH);
      const p = r.page;
      r.rowFrame(p.y, rowH, edges, i % 2 === 1 ? ZEBRA : undefined);
      r.text(r.fit(row.category, CW - 110 - 12, 10), MX + 6, p.y + 15, {
        size: 10,
      });
      r.text(yuan(row.cents), MX + CW - 6, p.y + 15, {
        size: 10,
        align: "right",
      });
      p.y += rowH;
    });
    r.ensure(rowH);
    {
      const p = r.page;
      r.rowFrame(p.y, rowH, edges, LIGHT_BG);
      r.text("合计", MX + 6, p.y + 15, { size: 10, bold: true });
      r.text(yuan(total), MX + CW - 6, p.y + 15, {
        size: 10,
        bold: true,
        align: "right",
      });
      p.y += rowH;
    }
  }

  // ---- 四、原始照片凭证 (always starts on a fresh page) ----
  if (photoGroups.length > 0) {
    r.newPage();
    r.sectionTitle("四、原始照片凭证");
    {
      const p = r.page;
      r.text(
        "所有凭证图片统一放入相同大小的图片框，保持原始比例，不拉伸变形。",
        MX,
        p.y + 9,
        { size: 8.5, color: DIM },
      );
      p.y += 20;
    }
    const frameW = 400;
    const frameH = 205;
    const frameX = (PW - frameW) / 2;
    const labelH = 16;
    const gap = 14;
    for (const group of photoGroups) {
      r.ensure(labelH + frameH + gap);
      {
        const p = r.page;
        r.text(r.fit(group.label, frameW, 9.5), PW / 2, p.y + 11, {
          size: 9.5,
          color: "#44505c",
          align: "center",
        });
        p.y += labelH;
      }
      for (let idx = 0; idx < group.bitmaps.length; idx++) {
        if (idx > 0) r.ensure(frameH + gap);
        const bitmap = group.bitmaps[idx] ?? null;
        const p = r.page;
        const { ctx } = p;
        const fy = p.y;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(frameX, fy, frameW, frameH);
        ctx.strokeStyle = "#b9c6d2";
        ctx.lineWidth = 0.8;
        ctx.strokeRect(frameX, fy, frameW, frameH);
        if (bitmap) {
          const { w, h } = bitmapSize(bitmap);
          const inset = 4;
          const availW = frameW - inset * 2;
          const availH = frameH - inset * 2;
          const scale = Math.min(availW / w, availH / h);
          const dw = w * scale;
          const dh = h * scale;
          ctx.drawImage(
            bitmap,
            frameX + (frameW - dw) / 2,
            fy + (frameH - dh) / 2,
            dw,
            dh,
          );
        } else {
          r.text("照片读取失败", PW / 2, fy + frameH / 2, {
            size: 10,
            color: DIM,
            align: "center",
          });
        }
        p.y = fy + frameH + gap;
      }
    }
  }

  // ---- Assemble the PDF from the rendered pages ----
  const pageJpegs: { bytes: Uint8Array; w: number; h: number }[] = [];
  for (const p of r.pages) {
    const blob = await new Promise<Blob | null>((resolve) =>
      p.canvas.toBlob(resolve, "image/jpeg", 0.88),
    );
    if (!blob) throw new Error("生成 PDF 失败，请重试");
    pageJpegs.push({
      bytes: new Uint8Array(await blob.arrayBuffer()),
      w: p.canvas.width,
      h: p.canvas.height,
    });
  }
  return new Blob([assemblePdf(pageJpegs)], { type: "application/pdf" });
}

/**
 * Annual statement: same shape as the monthly one, but the title block
 * covers the whole year, a per-month summary table sits between the totals
 * and the detail table, and the category section lists expense and income
 * categories separately when both kinds exist.
 */
export async function buildYearStatementPdf(args: {
  year: string; // YYYY
  transactions: ExportTx[];
  income_cents: number;
  expense_cents: number;
}): Promise<Blob> {
  const yearTitle = `${args.year}年度`;
  const balance = args.income_cents - args.expense_cents;

  const ordered = [...args.transactions].sort((a, b) =>
    a.occurred_on === b.occurred_on
      ? a.id - b.id
      : a.occurred_on < b.occurred_on
        ? -1
        : 1,
  );
  const codeOf = new Map<number, string>();
  ordered.forEach((tx, i) => {
    codeOf.set(tx.id, `Z${String(i + 1).padStart(3, "0")}`);
  });
  const itemOf = (tx: ExportTx) => tx.note.trim() || tx.category;

  const photoGroups: PhotoGroup[] = [];
  for (const tx of ordered) {
    if (tx.images.length === 0) continue;
    const bitmaps: (Bitmap | null)[] = [];
    for (const img of tx.images) {
      bitmaps.push(await loadBitmap(img.url));
    }
    photoGroups.push({
      label: `凭证 ${photoGroups.length + 1} · ${codeOf.get(tx.id) ?? ""} ${dayLabel(tx.occurred_on)} ${itemOf(tx)} ${yuanWithSymbol(tx.kind === "income" ? tx.amount_cents : -tx.amount_cents)}`,
      bitmaps,
    });
  }

  const r = new PdfRenderer(`${yearTitle}收支账单｜金额单位：人民币元`);

  // ---- Title block ----
  {
    const p = r.page;
    r.text(`${yearTitle}收支账单`, PW / 2, p.y + 20, {
      size: 20,
      bold: true,
      align: "center",
    });
    p.y += 34;
    r.text(
      `记账币种：人民币（CNY） | 账单期间：${args.year}年1月1日 至 ${args.year}年12月31日`,
      PW / 2,
      p.y + 10,
      { size: 9, color: DIM, align: "center" },
    );
    p.y += 26;
  }

  // ---- 一、收支汇总 ----
  r.sectionTitle("一、收支汇总");
  {
    const p = r.page;
    const colW = CW / 3;
    const edges = [MX + colW, MX + colW * 2];
    const headerY = p.y;
    r.rowFrame(headerY, 24, edges, LIGHT_BG);
    const labels = ["全年收入", "全年支出", "当前结余"];
    labels.forEach((label, i) => {
      r.text(label, MX + colW * i + colW / 2, headerY + 16, {
        size: 10,
        bold: true,
        color: "#44505c",
        align: "center",
      });
    });
    const valueY = headerY + 24;
    r.rowFrame(valueY, 32, edges);
    const values = [
      yuanWithSymbol(args.income_cents),
      yuanWithSymbol(args.expense_cents),
      yuanWithSymbol(balance),
    ];
    values.forEach((v, i) => {
      r.text(v, MX + colW * i + colW / 2, valueY + 21, {
        size: 13,
        bold: true,
        color: i === 2 && balance < 0 ? EXPENSE : INK,
        align: "center",
      });
    });
    r.tableOutline(headerY, 56);
    p.y = valueY + 32 + 14;
  }

  // ---- 二、月度汇总 ----
  r.sectionTitle("二、月度汇总");
  {
    const byMonth = new Map<string, { income: number; expense: number }>();
    for (const tx of ordered) {
      const key = tx.occurred_on.slice(0, 7);
      const slot = byMonth.get(key) ?? { income: 0, expense: 0 };
      if (tx.kind === "income") slot.income += tx.amount_cents;
      else slot.expense += tx.amount_cents;
      byMonth.set(key, slot);
    }
    const months = [...byMonth.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : 1,
    );
    // Columns: 月份 flex | 收入 110 | 支出 110 | 结余 110
    const edges = [MX + CW - 330, MX + CW - 220, MX + CW - 110];
    const headerH = 24;
    const rowH = 23;
    const drawHeader = () => {
      r.ensure(headerH);
      const p = r.page;
      const y = p.y;
      r.rowFrame(y, headerH, edges, LIGHT_BG);
      r.text("月份", MX + 6, y + 16, {
        size: 10,
        bold: true,
        color: "#44505c",
      });
      const heads = ["收入（元）", "支出（元）", "结余（元）"];
      heads.forEach((h, i) => {
        r.text(h, MX + CW - 110 * (2 - i) - 6, y + 16, {
          size: 10,
          bold: true,
          color: "#44505c",
          align: "right",
        });
      });
      p.y += headerH;
    };
    drawHeader();
    if (months.length === 0) {
      r.ensure(rowH);
      const p = r.page;
      r.rowFrame(p.y, rowH, edges);
      r.text("本年暂无记录", MX + 6, p.y + 15, { size: 10, color: DIM });
      p.y += rowH;
    }
    months.forEach(([key, slot], i) => {
      if (r.page.y + rowH > BOTTOM) {
        r.newPage();
        drawHeader();
      }
      const p = r.page;
      const y = p.y;
      r.rowFrame(y, rowH, edges, i % 2 === 1 ? ZEBRA : undefined);
      const base = y + 15;
      const [, m = "1"] = key.split("-");
      r.text(`${Number(m)}月`, MX + 6, base, { size: 10 });
      r.text(yuan(slot.income), MX + CW - 220 - 6, base, {
        size: 10,
        align: "right",
        color: slot.income > 0 ? INCOME : INK,
      });
      r.text(yuan(slot.expense), MX + CW - 110 - 6, base, {
        size: 10,
        align: "right",
      });
      const net = slot.income - slot.expense;
      r.text(yuanWithSymbol(net).replace("¥", ""), MX + CW - 6, base, {
        size: 10,
        align: "right",
        color: net < 0 ? EXPENSE : INK,
      });
      p.y += rowH;
    });
    if (months.length > 0) {
      r.ensure(rowH);
      const p = r.page;
      r.rowFrame(p.y, rowH, edges, LIGHT_BG);
      r.text("全年合计", MX + 6, p.y + 15, { size: 10, bold: true });
      r.text(yuan(args.income_cents), MX + CW - 220 - 6, p.y + 15, {
        size: 10,
        bold: true,
        align: "right",
      });
      r.text(yuan(args.expense_cents), MX + CW - 110 - 6, p.y + 15, {
        size: 10,
        bold: true,
        align: "right",
      });
      r.text(yuan(balance), MX + CW - 6, p.y + 15, {
        size: 10,
        bold: true,
        align: "right",
        color: balance < 0 ? EXPENSE : INK,
      });
      p.y += rowH;
    }
    r.page.y += 14;
  }

  // ---- 三、收支明细 ----
  const hasIncome = ordered.some((tx) => tx.kind === "income");
  r.sectionTitle(hasIncome ? "三、收支明细" : "三、消费明细");
  {
    const edges = [
      MX + 42,
      MX + 42 + 66,
      MX + CW - 78 - 92,
      MX + CW - 78,
    ];
    const headerH = 24;
    const rowH = 23;
    const drawHeader = () => {
      r.ensure(headerH);
      const p = r.page;
      const y = p.y;
      r.rowFrame(y, headerH, edges, HEADER_BG);
      const heads: { str: string; x: number; align?: CanvasTextAlign }[] = [
        { str: "编号", x: MX + 6 },
        { str: "日期", x: MX + 42 + 6 },
        { str: "消费项目", x: MX + 42 + 66 + 6 },
        { str: "类别", x: MX + CW - 78 - 92 + 6 },
        { str: "金额（元）", x: MX + CW - 6, align: "right" },
      ];
      for (const h of heads) {
        r.text(h.str, h.x, y + 16, {
          size: 10,
          bold: true,
          color: "#ffffff",
          align: h.align,
        });
      }
      p.y += headerH;
    };
    drawHeader();
    if (ordered.length === 0) {
      r.ensure(rowH);
      const p = r.page;
      r.rowFrame(p.y, rowH, edges);
      r.text("本年暂无记录", MX + 6, p.y + 15, { size: 10, color: DIM });
      p.y += rowH;
    }
    ordered.forEach((tx, i) => {
      if (r.page.y + rowH > BOTTOM) {
        r.newPage();
        drawHeader();
      }
      const p = r.page;
      const y = p.y;
      r.rowFrame(y, rowH, edges, i % 2 === 1 ? ZEBRA : undefined);
      const base = y + 15;
      r.text(codeOf.get(tx.id) ?? "", MX + 6, base, {
        size: 10,
        color: "#55606a",
      });
      r.text(dayLabel(tx.occurred_on), MX + 42 + 6, base, { size: 10 });
      const itemMax = CW - 78 - 92 - (42 + 66) - 12;
      r.text(r.fit(itemOf(tx), itemMax, 10), MX + 42 + 66 + 6, base, {
        size: 10,
      });
      const catMax = 92 - 12;
      r.text(r.fit(tx.category, catMax, 10), MX + CW - 78 - 92 + 6, base, {
        size: 10,
      });
      const amount =
        tx.kind === "income"
          ? `+${yuan(tx.amount_cents)}`
          : yuan(tx.amount_cents);
      r.text(amount, MX + CW - 6, base, {
        size: 10,
        align: "right",
        color: tx.kind === "income" ? INCOME : INK,
      });
      p.y += rowH;
    });
    r.page.y += 14;
  }

  // ---- 四、分类汇总 (expense and income separately when both exist) ----
  r.sectionTitle("四、分类汇总");
  {
    const drawCategoryTable = (kind: "income" | "expense", total: number) => {
      const map = new Map<string, number>();
      for (const tx of ordered) {
        if (tx.kind !== kind) continue;
        map.set(tx.category, (map.get(tx.category) ?? 0) + tx.amount_cents);
      }
      const rows = [...map.entries()]
        .map(([category, cents]) => ({ category, cents }))
        .sort((a, b) => b.cents - a.cents);
      if (rows.length === 0) return;
      const edges = [MX + CW - 110];
      const headerH = 24;
      const rowH = 23;
      r.ensure(headerH + 16);
      {
        const p = r.page;
        r.text(kind === "expense" ? "支出分类" : "收入分类", MX, p.y + 11, {
          size: 10.5,
          bold: true,
          color: "#44505c",
        });
        p.y += 16;
      }
      r.ensure(headerH);
      {
        const p = r.page;
        const y = p.y;
        r.rowFrame(y, headerH, edges, LIGHT_BG);
        r.text("类别", MX + 6, y + 16, {
          size: 10,
          bold: true,
          color: "#44505c",
        });
        r.text("金额（元）", MX + CW - 6, y + 16, {
          size: 10,
          bold: true,
          color: "#44505c",
          align: "right",
        });
        p.y += headerH;
      }
      rows.forEach((row, i) => {
        r.ensure(rowH);
        const p = r.page;
        r.rowFrame(p.y, rowH, edges, i % 2 === 1 ? ZEBRA : undefined);
        r.text(r.fit(row.category, CW - 110 - 12, 10), MX + 6, p.y + 15, {
          size: 10,
        });
        r.text(yuan(row.cents), MX + CW - 6, p.y + 15, {
          size: 10,
          align: "right",
        });
        p.y += rowH;
      });
      r.ensure(rowH);
      {
        const p = r.page;
        r.rowFrame(p.y, rowH, edges, LIGHT_BG);
        r.text("合计", MX + 6, p.y + 15, { size: 10, bold: true });
        r.text(yuan(total), MX + CW - 6, p.y + 15, {
          size: 10,
          bold: true,
          align: "right",
        });
        p.y += rowH + 12;
      }
    };
    drawCategoryTable("expense", args.expense_cents);
    drawCategoryTable("income", args.income_cents);
    if (ordered.length === 0) {
      r.ensure(23);
      const p = r.page;
      r.text("暂无", MX + 6, p.y + 15, { size: 10, color: DIM });
      p.y += 23;
    }
  }

  // ---- 五、原始照片凭证 ----
  if (photoGroups.length > 0) {
    r.newPage();
    r.sectionTitle("五、原始照片凭证");
    {
      const p = r.page;
      r.text(
        "所有凭证图片统一放入相同大小的图片框，保持原始比例，不拉伸变形。",
        MX,
        p.y + 9,
        { size: 8.5, color: DIM },
      );
      p.y += 20;
    }
    const frameW = 400;
    const frameH = 205;
    const frameX = (PW - frameW) / 2;
    const labelH = 16;
    const gap = 14;
    for (const group of photoGroups) {
      r.ensure(labelH + frameH + gap);
      {
        const p = r.page;
        r.text(r.fit(group.label, frameW, 9.5), PW / 2, p.y + 11, {
          size: 9.5,
          color: "#44505c",
          align: "center",
        });
        p.y += labelH;
      }
      for (let idx = 0; idx < group.bitmaps.length; idx++) {
        if (idx > 0) r.ensure(frameH + gap);
        const bitmap = group.bitmaps[idx] ?? null;
        const p = r.page;
        const { ctx } = p;
        const fy = p.y;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(frameX, fy, frameW, frameH);
        ctx.strokeStyle = "#b9c6d2";
        ctx.lineWidth = 0.8;
        ctx.strokeRect(frameX, fy, frameW, frameH);
        if (bitmap) {
          const { w, h } = bitmapSize(bitmap);
          const inset = 4;
          const availW = frameW - inset * 2;
          const availH = frameH - inset * 2;
          const scale = Math.min(availW / w, availH / h);
          const dw = w * scale;
          const dh = h * scale;
          ctx.drawImage(
            bitmap,
            frameX + (frameW - dw) / 2,
            fy + (frameH - dh) / 2,
            dw,
            dh,
          );
        } else {
          r.text("照片读取失败", PW / 2, fy + frameH / 2, {
            size: 10,
            color: DIM,
            align: "center",
          });
        }
        p.y = fy + frameH + gap;
      }
    }
  }

  const pageJpegs: { bytes: Uint8Array; w: number; h: number }[] = [];
  for (const p of r.pages) {
    const blob = await new Promise<Blob | null>((resolve) =>
      p.canvas.toBlob(resolve, "image/jpeg", 0.88),
    );
    if (!blob) throw new Error("生成 PDF 失败，请重试");
    pageJpegs.push({
      bytes: new Uint8Array(await blob.arrayBuffer()),
      w: p.canvas.width,
      h: p.canvas.height,
    });
  }
  return new Blob([assemblePdf(pageJpegs)], { type: "application/pdf" });
}

/** Minimal PDF writer: one full-page JPEG XObject per page. */
function assemblePdf(
  pages: { bytes: Uint8Array; w: number; h: number }[],
): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (data: Uint8Array | string) => {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    parts.push(bytes);
    length += bytes.length;
  };
  const beginObj = (num: number) => {
    offsets[num] = length;
    push(`${num} 0 obj\n`);
  };

  push("%PDF-1.4\n");
  const pageObjNums = pages.map((_, i) => 3 + i * 3);
  beginObj(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  beginObj(2);
  push(
    `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj\n`,
  );
  pages.forEach((page, i) => {
    const pageNum = 3 + i * 3;
    const contentNum = pageNum + 1;
    const imageNum = pageNum + 2;
    beginObj(pageNum);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] ` +
        `/Resources << /XObject << /Im${i} ${imageNum} 0 R >> >> ` +
        `/Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    const content = `q\n${PW} 0 0 ${PH} 0 0 cm\n/Im${i} Do\nQ\n`;
    beginObj(contentNum);
    push(
      `<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`,
    );
    beginObj(imageNum);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${page.w} /Height ${page.h} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${page.bytes.length} >>\nstream\n`,
    );
    push(page.bytes);
    push("\nendstream\nendobj\n");
  });

  const xrefStart = length;
  const objCount = 3 + pages.length * 3;
  push(`xref\n0 ${objCount}\n`);
  push("0000000000 65535 f \n");
  for (let n = 1; n < objCount; n++) {
    push(`${String(offsets[n] ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  push(
    `trailer\n<< /Size ${objCount} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );

  const out = new Uint8Array(length);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
