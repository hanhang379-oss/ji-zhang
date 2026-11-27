import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim, fileToBase64 } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import { api, type ApiResponse } from "./api";
import { buildStatementPdf, buildYearStatementPdf } from "./exportPdf";
import type { Actions } from "../../server/src/actions";

const FIELDS = actionFields<typeof Actions>();

type Tx = ApiResponse<typeof api, "getMonth">["transactions"][number];
type TxImage = Tx["images"][number];
type Kind = "income" | "expense";

const EXPENSE_CATEGORIES = [
  "餐饮",
  "交通",
  "购物",
  "居住",
  "娱乐",
  "医疗",
  "学习",
  "文具",
  "生活",
  "其他",
];
const INCOME_CATEGORIES = ["老师拨款", "其他收入"];
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const MAX_IMAGES = 9;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function shiftMonth(month: string, delta: number): string {
  const [y = 1970, m = 1] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function monthTitle(month: string): string {
  const [y = "", m = ""] = month.split("-");
  return `${y}年${Number(m)}月`;
}

function dayLabel(day: string): string {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return `${m}月${d}日 ${WEEKDAYS[date.getDay()] ?? ""}`;
}

/** cents -> "¥1,234.50" */
function fmtMoney(cents: number): string {
  const v = Math.abs(cents) / 100;
  return `¥${v.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function signedMoney(kind: Kind, cents: number): string {
  return `${kind === "income" ? "+" : "−"}${fmtMoney(cents)}`;
}

/** "12.3" -> 1230 cents; null when invalid. */
function parseAmountToCents(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [yuan = "0", fen = ""] = s.split(".");
  const cents = Number(yuan) * 100 + Number(fen.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  if (cents > 100_000_000_00) return null;
  return cents;
}

function centsToInput(cents: number): string {
  const v = cents / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

interface PendingImage {
  dataBase64: string;
  mimeType: "image/jpeg" | "image/png";
  previewUrl: string;
}

/**
 * Prepare a picked photo for upload: downscale big phone photos to at most
 * 1600px on the long edge as JPEG; fall back to the raw file when decoding
 * fails, and reject formats the server doesn't store.
 */
async function prepareImage(file: File): Promise<PendingImage> {
  const previewUrl = URL.createObjectURL(file);
  try {
    const bmp = await createImageBitmap(file);
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const cx = canvas.getContext("2d");
    if (cx) {
      cx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const dataBase64 = (canvas.toDataURL("image/jpeg", 0.82).split(",")[1] ?? "");
      if (dataBase64) {
        return { dataBase64, mimeType: "image/jpeg", previewUrl };
      }
    }
  } catch {
    // Fall through to the raw file below.
  }
  const { dataBase64, mimeType } = await fileToBase64(file);
  if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
    throw new Error("这张照片的格式不支持，换一张试试");
  }
  return { dataBase64, mimeType, previewUrl };
}

interface FormState {
  kind: Kind;
  amount: string;
  category: string;
  note: string;
  date: string;
}

function blankForm(): FormState {
  return {
    kind: "expense",
    amount: "",
    category: EXPENSE_CATEGORIES[0] ?? "其他",
    note: "",
    date: todayStr(),
  };
}

function formFromTx(tx: Tx): FormState {
  return {
    kind: tx.kind,
    amount: centsToInput(tx.amount_cents),
    category: tx.category,
    note: tx.note,
    date: tx.occurred_on,
  };
}

type SheetState = { mode: "add" } | { mode: "edit"; tx: Tx } | null;

export function App() {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(currentMonth);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [formError, setFormError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportingYear, setExportingYear] = useState(false);
  const [exportError, setExportError] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);
  // Tracks a half-finished "add" (record saved, photos still uploading) so a
  // retry after a failed photo upload doesn't create a duplicate record.
  const addProgressRef = useRef<{ txId: number; uploaded: number } | null>(
    null,
  );

  const monthQuery = useQuery({
    queryKey: ["month", month],
    queryFn: () => api.getMonth({ month }),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["month"] });

  const errMsg = (e: unknown) =>
    e instanceof Error && e.message ? e.message : "保存失败，请重试";

  const addMutation = useMutation({
    mutationFn: async (input: {
      kind: Kind;
      amount_cents: number;
      category: string;
      note: string;
      occurred_on: string;
    }) => await api.addTransaction(input),
    onError: (e) => setFormError(errMsg(e)),
  });

  const updateMutation = useMutation({
    mutationFn: async (input: {
      id: number;
      kind: Kind;
      amount_cents: number;
      category: string;
      note: string;
      occurred_on: string;
    }) => await api.updateTransaction(input),
    onError: (e) => setFormError(errMsg(e)),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => await api.deleteTransaction({ id }),
    onSuccess: () => {
      setSheet(null);
      setFormError("");
      void invalidate();
    },
    onError: (e) => setFormError(errMsg(e)),
  });

  const addImageMutation = useMutation({
    mutationFn: async (input: {
      tx_id: number;
      image: { dataBase64: string; mimeType: "image/jpeg" | "image/png" };
    }) => await api.addImage(input),
    onError: (e) => setFormError(errMsg(e)),
  });

  const deleteImageMutation = useMutation({
    mutationFn: async (id: number) => await api.deleteImage({ id }),
    onSuccess: () => void invalidate(),
    onError: (e) => setFormError(errMsg(e)),
  });

  const data = monthQuery.data;
  const balance = data ? data.income_cents - data.expense_cents : 0;
  const isCurrentMonth = month === currentMonth();

  const groups = useMemo(() => {
    const out: { day: string; items: Tx[]; net: number }[] = [];
    if (!data) return out;
    for (const tx of data.transactions) {
      const signed = tx.kind === "income" ? tx.amount_cents : -tx.amount_cents;
      const last = out[out.length - 1];
      if (last && last.day === tx.occurred_on) {
        last.items.push(tx);
        last.net += signed;
      } else {
        out.push({ day: tx.occurred_on, items: [tx], net: signed });
      }
    }
    return out;
  }, [data]);

  const breakdown = useMemo(() => {
    const build = (kind: Kind) => {
      const map = new Map<string, number>();
      let total = 0;
      for (const tx of data?.transactions ?? []) {
        if (tx.kind !== kind) continue;
        map.set(tx.category, (map.get(tx.category) ?? 0) + tx.amount_cents);
        total += tx.amount_cents;
      }
      return {
        total,
        items: [...map.entries()]
          .map(([category, cents]) => ({ category, cents }))
          .sort((a, b) => b.cents - a.cents),
      };
    };
    return { expense: build("expense"), income: build("income") };
  }, [data]);

  const openAdd = () => {
    setFormError("");
    addProgressRef.current = null;
    setSheet({ mode: "add" });
  };

  const openEdit = (tx: Tx) => {
    setFormError("");
    addProgressRef.current = null;
    setSheet({ mode: "edit", tx });
  };

  const submitForm = async (form: FormState, pending: PendingImage[]) => {
    const cents = parseAmountToCents(form.amount);
    if (cents === null) {
      setFormError("金额填得不对：输入大于 0 的数字，最多两位小数。");
      return;
    }
    if (!form.category.trim()) {
      setFormError("选个分类吧。");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) {
      setFormError("选个日期吧。");
      return;
    }
    const payload = {
      kind: form.kind,
      amount_cents: cents,
      category: form.category.trim(),
      note: form.note.trim(),
      occurred_on: form.date,
    };
    // If the entry moved to another month, jump there so it stays visible.
    const targetMonth = form.date.slice(0, 7);
    try {
      if (sheet?.mode === "edit") {
        await updateMutation.mutateAsync({ id: sheet.tx.id, ...payload });
        for (const img of pending) {
          await addImageMutation.mutateAsync({
            tx_id: sheet.tx.id,
            image: { dataBase64: img.dataBase64, mimeType: img.mimeType },
          });
        }
      } else {
        if (!addProgressRef.current) {
          const { id } = await addMutation.mutateAsync(payload);
          addProgressRef.current = { txId: id, uploaded: 0 };
        }
        const progress = addProgressRef.current;
        for (const img of pending.slice(progress.uploaded)) {
          await addImageMutation.mutateAsync({
            tx_id: progress.txId,
            image: { dataBase64: img.dataBase64, mimeType: img.mimeType },
          });
          progress.uploaded += 1;
        }
      }
    } catch {
      // The mutation's onError already put the message next to the form;
      // keep the sheet open so nothing typed or picked is lost.
      return;
    }
    addProgressRef.current = null;
    setSheet(null);
    setFormError("");
    setMonth(targetMonth);
    void invalidate();
  };

  const saving =
    addMutation.isPending ||
    updateMutation.isPending ||
    addImageMutation.isPending;

  const exportPdf = async () => {
    if (!data || exporting) return;
    setExporting(true);
    setExportError("");
    try {
      const blob = await buildStatementPdf({
        month,
        monthTitle: monthTitle(month),
        transactions: data.transactions,
        income_cents: data.income_cents,
        expense_cents: data.expense_cents,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${monthTitle(month)}收支账单.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setExportError("导出失败，请重试。");
    } finally {
      setExporting(false);
    }
  };

  const year = month.slice(0, 4);

  const exportYearPdf = async () => {
    if (exportingYear) return;
    setExportingYear(true);
    setExportError("");
    try {
      const yearData = await api.getYear({ year });
      if (yearData.transactions.length === 0) {
        setExportError(`${year} 年还没有记录，没法导出年度账单。`);
        return;
      }
      const blob = await buildYearStatementPdf({
        year,
        transactions: yearData.transactions,
        income_cents: yearData.income_cents,
        expense_cents: yearData.expense_cents,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${year}年度收支账单.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setExportError("导出失败，请重试。");
    } finally {
      setExportingYear(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />

      <main className="mx-auto w-full max-w-2xl px-4 pb-28">
        {/* Month switcher */}
        <div className="flex items-center justify-between pt-5">
          <button
            type="button"
            aria-label="上个月"
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
            className="flex h-10 w-10 items-center justify-center rounded-full text-xl text-[var(--dim)] active:bg-[var(--accent-soft)]"
          >
            ‹
          </button>
          <div className="text-center">
            <p className="text-lg font-semibold">{monthTitle(month)}</p>
            {!isCurrentMonth && (
              <button
                type="button"
                onClick={() => setMonth(currentMonth())}
                className="text-xs text-[var(--accent)] underline underline-offset-2"
              >
                回到本月
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label="下个月"
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
            className="flex h-10 w-10 items-center justify-center rounded-full text-xl text-[var(--dim)] active:bg-[var(--accent-soft)]"
          >
            ›
          </button>
        </div>

        {/* Balance hero: what's left of the teacher's money */}
        <section aria-label="本月汇总" className="mt-4 text-center">
          <p className="text-sm text-[var(--dim)]">
            {balance < 0 ? "已超支" : "剩余"}
          </p>
          {monthQuery.isPending ? (
            <p className="num mt-1 text-4xl font-semibold">—</p>
          ) : (
            <p
              className="num mt-1 text-4xl font-semibold"
              style={{
                color: balance < 0 ? "var(--expense)" : "var(--text)",
              }}
            >
              {balance < 0 ? "−" : ""}
              {fmtMoney(balance)}
            </p>
          )}
          <div className="num mx-auto mt-4 flex max-w-sm items-center justify-center gap-6 border-y border-[var(--border)] py-3 text-sm">
            <span>
              <span className="text-[var(--dim)]">老师共给 </span>
              <span style={{ color: "var(--income)" }}>
                {data ? fmtMoney(data.income_cents) : "—"}
              </span>
            </span>
            <span className="h-4 w-px bg-[var(--border)]" aria-hidden="true" />
            <span>
              <span className="text-[var(--dim)]">已支出 </span>
              <span style={{ color: "var(--expense)" }}>
                {data ? fmtMoney(data.expense_cents) : "—"}
              </span>
            </span>
          </div>
          <div className="mt-4">
            <button
              type="button"
              onClick={() => void exportPdf()}
              disabled={!data || data.transactions.length === 0 || exporting}
              className="rounded-full border px-5 py-2 text-sm font-medium disabled:opacity-50"
              style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
            >
              {exporting ? "正在生成 PDF…" : "导出本月 PDF 账单"}
            </button>
            <p className="mt-1.5 text-xs text-[var(--dim)]">
              含收支明细和照片凭证，跟之前那份账单一个格式
            </p>
            <button
              type="button"
              onClick={() => void exportYearPdf()}
              disabled={exportingYear}
              className="mt-3 rounded-full border px-5 py-2 text-sm font-medium disabled:opacity-50"
              style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
            >
              {exportingYear ? "正在生成 PDF…" : `导出 ${year} 年度账单`}
            </button>
            <p className="mt-1.5 text-xs text-[var(--dim)]">
              整年的账：全年汇总、逐月汇总、全年明细和照片凭证
            </p>
            {exportError && (
              <p
                role="alert"
                className="mt-1 text-sm"
                style={{ color: "var(--expense)" }}
              >
                {exportError}
              </p>
            )}
          </div>
        </section>

        {/* Body states */}
        {monthQuery.isPending && (
          <p className="py-12 text-center text-sm text-[var(--dim)]">
            加载中…
          </p>
        )}
        {monthQuery.isError && (
          <div className="py-12 text-center">
            <p className="text-sm text-[var(--dim)]">这个月的账没加载出来。</p>
            <button
              type="button"
              onClick={() => void monthQuery.refetch()}
              className="mt-3 rounded-full border border-[var(--border)] px-4 py-2 text-sm"
            >
              重试
            </button>
          </div>
        )}

        {data && data.transactions.length === 0 && (
          <div className="py-14 text-center">
            <p className="text-base">这个月还没有记录</p>
            <p className="mx-auto mt-1 max-w-xs text-sm text-[var(--dim)]">
              老师给你钱时记一笔「收入」；花出去时记一笔「支出」，顺手拍下小票或买到的东西，留作凭证。
            </p>
            <button
              type="button"
              onClick={openAdd}
              className="mt-5 rounded-full px-5 py-2.5 text-sm font-medium text-white"
              style={{ backgroundColor: "var(--accent)" }}
            >
              记第一笔
            </button>
          </div>
        )}

        {data && data.transactions.length > 0 && (
          <>
            {/* Category breakdown */}
            {(breakdown.expense.items.length > 0 ||
              breakdown.income.items.length > 0) && (
              <section aria-label="分类汇总" className="mt-6 space-y-5">
                <CategoryBars
                  title="支出构成"
                  color="var(--expense)"
                  total={breakdown.expense.total}
                  items={breakdown.expense.items}
                />
                <CategoryBars
                  title="收入构成"
                  color="var(--income)"
                  total={breakdown.income.total}
                  items={breakdown.income.items}
                />
              </section>
            )}

            {/* Day-grouped list */}
            <section aria-label="账目明细" className="mt-8">
              {groups.map((g) => (
                <div key={g.day} className="mb-5">
                  <div className="flex items-baseline justify-between border-b border-[var(--border)] pb-1.5">
                    <h2 className="text-sm font-medium text-[var(--dim)]">
                      {dayLabel(g.day)}
                    </h2>
                    <span className="num text-xs text-[var(--dim)]">
                      {g.net === 0
                        ? "±¥0.00"
                        : `${g.net > 0 ? "+" : "−"}${fmtMoney(g.net)}`}
                    </span>
                  </div>
                  <ul>
                    {g.items.map((tx) => (
                      <li key={tx.id}>
                        <button
                          type="button"
                          onClick={() => openEdit(tx)}
                          className="flex w-full items-center gap-3 py-3 text-left active:bg-[var(--accent-soft)]"
                          aria-label={`编辑 ${tx.category} ${signedMoney(tx.kind, tx.amount_cents)}`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-base">
                              {tx.category}
                              {tx.note && (
                                <span className="text-[var(--dim)]">
                                  {" · "}
                                  {tx.note}
                                </span>
                              )}
                            </span>
                          </span>
                          <span
                            className="num shrink-0 text-base font-medium"
                            style={{
                              color:
                                tx.kind === "income"
                                  ? "var(--income)"
                                  : "var(--expense)",
                            }}
                          >
                            {signedMoney(tx.kind, tx.amount_cents)}
                          </span>
                        </button>
                        {tx.images.length > 0 && (
                          <div className="flex flex-wrap gap-2 pb-3">
                            {tx.images.map((img) => (
                              <button
                                key={img.id}
                                type="button"
                                onClick={() => setLightbox(img.url)}
                                aria-label="查看照片凭证"
                                className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-[var(--border)]"
                              >
                                <img
                                  src={img.url}
                                  alt="这笔账的照片凭证"
                                  loading="lazy"
                                  className="h-full w-full object-cover"
                                />
                              </button>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          </>
        )}
      </main>

      {/* Add button */}
      <button
        type="button"
        onClick={openAdd}
        className="fixed right-4 bottom-6 z-40 rounded-full px-6 py-3.5 text-base font-medium text-white shadow-lg"
        style={{ backgroundColor: "var(--accent)" }}
      >
        ＋ 记一笔
      </button>

      {/* Add / edit sheet */}
      {sheet && (
        <TxSheet
          key={sheet.mode === "edit" ? sheet.tx.id : "add"}
          initial={
            sheet.mode === "edit" ? formFromTx(sheet.tx) : blankForm()
          }
          existingImages={sheet.mode === "edit" ? sheet.tx.images : []}
          isEdit={sheet.mode === "edit"}
          error={formError}
          saving={saving}
          deleting={deleteMutation.isPending}
          deletingImage={deleteImageMutation.isPending}
          onClose={() => setSheet(null)}
          onSubmit={(form, pending) => void submitForm(form, pending)}
          onPreview={(url) => setLightbox(url)}
          onDeleteImage={
            sheet.mode === "edit"
              ? (id) => deleteImageMutation.mutate(id)
              : undefined
          }
          onDelete={
            sheet.mode === "edit"
              ? () => deleteMutation.mutate(sheet.tx.id)
              : undefined
          }
        />
      )}

      {/* Full-screen photo viewer */}
      {lightbox && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/90 p-4">
          <button
            type="button"
            aria-label="关闭照片"
            onClick={() => setLightbox(null)}
            className="absolute inset-0"
          />
          <img
            src={lightbox}
            alt="照片凭证大图"
            className="relative max-h-full max-w-full rounded-lg object-contain"
          />
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-lg text-white"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

function CategoryBars({
  title,
  color,
  total,
  items,
}: {
  title: string;
  color: string;
  total: number;
  items: { category: string; cents: number }[];
}) {
  if (items.length === 0 || total <= 0) return null;
  return (
    <div>
      <h2 className="text-sm font-medium text-[var(--dim)]">{title}</h2>
      <ul className="mt-2 space-y-2.5">
        {items.map((it) => (
          <li key={it.category}>
            <div className="flex items-baseline justify-between text-sm">
              <span>{it.category}</span>
              <span className="num text-[var(--dim)]">
                {fmtMoney(it.cents)} · {Math.round((it.cents / total) * 100)}%
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(2, (it.cents / total) * 100)}%`,
                  backgroundColor: color,
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TxSheet({
  initial,
  existingImages,
  isEdit,
  error,
  saving,
  deleting,
  deletingImage,
  onClose,
  onSubmit,
  onPreview,
  onDeleteImage,
  onDelete,
}: {
  initial: FormState;
  existingImages: TxImage[];
  isEdit: boolean;
  error: string;
  saving: boolean;
  deleting: boolean;
  deletingImage: boolean;
  onClose: () => void;
  onSubmit: (form: FormState, pending: PendingImage[]) => void;
  onPreview: (url: string) => void;
  onDeleteImage?: (id: number) => void;
  onDelete?: () => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [photoError, setPhotoError] = useState("");
  const [reading, setReading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const categories =
    form.kind === "expense" ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;

  const setKind = (kind: Kind) =>
    setForm((f) => ({
      ...f,
      kind,
      category:
        kind === "expense"
          ? (EXPENSE_CATEGORIES[0] ?? "其他")
          : (INCOME_CATEGORIES[0] ?? "其他"),
    }));

  const onPickFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setPhotoError("");
    const room = MAX_IMAGES - existingImages.length - pendingImages.length;
    if (room <= 0) {
      setPhotoError(`一笔最多留 ${MAX_IMAGES} 张照片。`);
      return;
    }
    setReading(true);
    try {
      const picked: PendingImage[] = [];
      for (const f of files.slice(0, room)) {
        picked.push(await prepareImage(f));
      }
      setPendingImages((p) => [...p, ...picked]);
      if (files.length > room) {
        setPhotoError(`一笔最多留 ${MAX_IMAGES} 张照片，多出的没加上。`);
      }
    } catch (err) {
      setPhotoError(
        err instanceof Error && err.message
          ? err.message
          : "这张照片加不上，换一张试试。",
      );
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-label={isEdit ? "编辑这笔账" : "记一笔"}
        className="relative max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-[var(--surface)] p-5 pb-8 sm:rounded-2xl"
      >
        {/* Kind toggle */}
        <div
          className="grid grid-cols-2 gap-1 rounded-full bg-[var(--bg)] p-1"
          role="group"
          aria-label="收支类型"
        >
          {(["expense", "income"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={form.kind === k}
              onClick={() => setKind(k)}
              className="rounded-full py-2 text-sm font-medium"
              style={
                form.kind === k
                  ? {
                      backgroundColor:
                        k === "expense" ? "var(--expense)" : "var(--income)",
                      color: "#fff",
                    }
                  : { color: "var(--dim)" }
              }
            >
              {k === "expense" ? "支出" : "收入"}
            </button>
          ))}
        </div>

        {/* Amount */}
        <label
          htmlFor="tx-amount"
          className="mt-5 block text-sm text-[var(--dim)]"
        >
          金额（元）
        </label>
        <div className="mt-1 flex items-baseline gap-1 border-b-2 border-[var(--border)] pb-2 focus-within:border-[var(--accent)]">
          <span className="text-2xl text-[var(--dim)]">¥</span>
          <input
            {...FIELDS.addTransaction.amount_cents}
            id="tx-amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            className="num w-full bg-transparent text-3xl font-semibold outline-none"
            aria-label="金额（元）"
          />
        </div>

        {/* Categories */}
        <p className="mt-5 text-sm text-[var(--dim)]">分类</p>
        <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="分类">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={form.category === c}
              onClick={() => setForm((f) => ({ ...f, category: c }))}
              className="rounded-full border px-3.5 py-1.5 text-sm"
              style={
                form.category === c
                  ? {
                      borderColor: "var(--accent)",
                      backgroundColor: "var(--accent-soft)",
                      color: "var(--accent)",
                      fontWeight: 600,
                    }
                  : { borderColor: "var(--border)", color: "var(--text)" }
              }
            >
              {c}
            </button>
          ))}
        </div>

        {/* Date + purpose */}
        <div className="mt-5 grid grid-cols-[1fr_1.4fr] gap-3">
          <div>
            <label
              htmlFor="tx-date"
              className="block text-sm text-[var(--dim)]"
            >
              日期
            </label>
            <input
              {...FIELDS.addTransaction.occurred_on}
              id="tx-date"
              type="date"
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-2 text-sm"
            />
          </div>
          <div>
            <label
              htmlFor="tx-note"
              className="block text-sm text-[var(--dim)]"
            >
              用途说明
            </label>
            <input
              {...FIELDS.addTransaction.note}
              id="tx-note"
              type="text"
              placeholder={
                form.kind === "expense"
                  ? "这笔钱用来干什么"
                  : "比如：这学期的材料费"
              }
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-2.5 py-2 text-sm"
            />
          </div>
        </div>

        {/* Photo evidence */}
        <div className="mt-5">
          <p className="text-sm text-[var(--dim)]">照片凭证</p>
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            拍下小票、发票，或者买到的东西，之后对账时能对上。
          </p>
          {(existingImages.length > 0 || pendingImages.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-2">
              {existingImages.map((img) => (
                <span key={img.id} className="relative block h-20 w-20">
                  <button
                    type="button"
                    onClick={() => onPreview(img.url)}
                    aria-label="查看照片凭证"
                    className="block h-full w-full overflow-hidden rounded-lg border border-[var(--border)]"
                  >
                    <img
                      src={img.url}
                      alt="这笔账的照片凭证"
                      className="h-full w-full object-cover"
                    />
                  </button>
                  {onDeleteImage && (
                    <button
                      type="button"
                      aria-label="删除这张照片"
                      disabled={deletingImage}
                      onClick={() => onDeleteImage(img.id)}
                      className="absolute -top-1.5 -right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-xs text-white disabled:opacity-50"
                    >
                      ✕
                    </button>
                  )}
                </span>
              ))}
              {pendingImages.map((img, i) => (
                <span
                  key={img.previewUrl}
                  className="relative block h-20 w-20"
                >
                  <button
                    type="button"
                    onClick={() => onPreview(img.previewUrl)}
                    aria-label="查看待保存的照片"
                    className="block h-full w-full overflow-hidden rounded-lg border border-[var(--border)]"
                  >
                    <img
                      src={img.previewUrl}
                      alt="待保存的照片凭证"
                      className="h-full w-full object-cover"
                    />
                  </button>
                  <button
                    type="button"
                    aria-label="移除这张照片"
                    onClick={() =>
                      setPendingImages((p) => p.filter((_, j) => j !== i))
                    }
                    className="absolute -top-1.5 -right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-xs text-white"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={reading}
            className="mt-2 rounded-full border border-dashed border-[var(--border)] px-4 py-2 text-sm disabled:opacity-50"
            style={{ color: "var(--accent)" }}
          >
            {reading ? "读取照片中…" : "＋ 添加照片"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            aria-label="添加照片"
            className="hidden"
            onChange={(e) => void onPickFiles(e)}
          />
          {photoError && (
            <p
              role="alert"
              className="mt-2 text-sm"
              style={{ color: "var(--expense)" }}
            >
              {photoError}
            </p>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-4 text-sm" style={{ color: "var(--expense)" }}>
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={saving}
          onClick={() => onSubmit(form, pendingImages)}
          className="mt-6 w-full rounded-full py-3 text-base font-medium text-white disabled:opacity-50"
          style={{ backgroundColor: "var(--accent)" }}
        >
          {saving ? "保存中…" : isEdit ? "保存修改" : "记一笔"}
        </button>

        {isEdit && onDelete && (
          <div className="mt-4 text-center">
            {confirmDelete ? (
              <div className="flex items-center justify-center gap-3">
                <span className="text-sm text-[var(--dim)]">确定删掉这笔？</span>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={onDelete}
                  className="rounded-full px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  style={{ backgroundColor: "var(--expense)" }}
                >
                  {deleting ? "删除中…" : "删除"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-full border border-[var(--border)] px-4 py-1.5 text-sm"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="px-4 py-2 text-sm"
                style={{ color: "var(--expense)" }}
              >
                删除这笔
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
