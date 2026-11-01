import { useState } from "react";

const MAX_BYTES = 280 * 1024; // DBの上限（data URL で約400KB）に収まる大きさ

/** ロゴ・社印の画像（PNG / JPEG）を選び、data URL にして渡す。帳票には、発行時にその内容が固定される。 */
export function ImageField({ label, value, onChange, disabled }: { label: string; value: string | null; onChange: (v: string | null) => void; disabled?: boolean }) {
  const [err, setErr] = useState<string | null>(null);
  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.type !== "image/png" && file.type !== "image/jpeg") return setErr("PNG または JPEG の画像を選んでください");
    if (file.size > MAX_BYTES) return setErr(`画像が大きすぎます（${Math.round(MAX_BYTES / 1024)}KBまで。今は ${Math.round(file.size / 1024)}KB）`);
    const r = new FileReader();
    r.onload = () => { setErr(null); onChange(String(r.result)); };
    r.readAsDataURL(file);
  }
  return (
    <div className="stack wide">
      <span>{label}</span>
      <div className="img-field">
        {value ? <img src={value} alt={label} /> : <span className="inactive">未登録</span>}
        {!disabled && <input type="file" accept="image/png,image/jpeg" onChange={pick} />}
        {!disabled && value && <button type="button" className="secondary" onClick={() => onChange(null)}>画像を外す</button>}
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}
