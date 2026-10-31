import { useState } from "react";
import type { Field } from "../lib/masters";

export type Row = Record<string, string | number | boolean | null> & { id?: string; active?: boolean };

/** 入力値 → DBへ送る値。空欄は null、数値項目は数値にする。 */
export function toPayload(fields: Field[], form: Record<string, string>, active: boolean) {
  const out: Record<string, string | number | boolean | null> = { active };
  for (const f of fields) {
    const v = (form[f.key] ?? "").trim();
    out[f.key] = v === "" ? null : f.bool ? v === "true" : f.numeric ? Number(v) : v;
  }
  return out;
}

export function MasterForm(props: {
  fields: Field[]; initial: Row | null; busy: boolean; error: string | null;
  onSave: (payload: ReturnType<typeof toPayload>) => void; onCancel: () => void;
}) {
  const { fields, initial } = props;
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, initial?.[f.key] == null ? defaultOf(f) : String(initial[f.key])])));
  const [active, setActive] = useState(initial?.active ?? true);
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  return (
    <form className="card form" onSubmit={(e) => { e.preventDefault(); props.onSave(toPayload(fields, form, active)); }}>
      <h3>{initial ? "編集" : "新規登録"}</h3>
      {fields.map((f) => (
        <label key={f.key}>{f.label}{f.required && " *"}
          {f.type === "select" ? (
            <select value={form[f.key]} onChange={(e) => set(f.key, e.target.value)} required={f.required}>
              {f.options!.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
          ) : f.type === "textarea" ? (
            <textarea value={form[f.key]} onChange={(e) => set(f.key, e.target.value)} rows={3} />
          ) : (
            <input type={f.type === "email" ? "email" : "text"} value={form[f.key]} pattern={f.pattern}
              title={f.hint} placeholder={f.hint} required={f.required} onChange={(e) => set(f.key, e.target.value)} />
          )}
        </label>
      ))}
      <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> 取引中（外すと選択肢から外れます）</label>
      {props.error && <p className="error">{props.error}</p>}
      <div className="row">
        <button disabled={props.busy}>{props.busy ? "保存中…" : "保存"}</button>
        <button type="button" className="secondary" onClick={props.onCancel}>キャンセル</button>
      </div>
    </form>
  );
}

// 新規のときの初期値（selectは先頭、ただし締め日・支払は業務上の標準値）
function defaultOf(f: Field): string {
  if (f.type !== "select") return "";
  const std: Record<string, string> = { closing_day: "31", payment_month_offset: "1", payment_day: "31", billing_basis: "per_delivery" };
  return std[f.key] ?? f.options![0][0];
}
