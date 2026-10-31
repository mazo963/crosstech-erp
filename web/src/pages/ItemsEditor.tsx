import type { ItemForm } from "../lib/projects";
import { emptyItem } from "../lib/projects";
import { yen } from "../lib/format";

type Opt = { id: string; name: string };

/** 品目行の入力表。金額は保存済み行のみ、DBの view（v_item_progress）の値を表示する。 */
export function ItemsEditor(props: {
  items: ItemForm[]; vendors: Opt[]; amounts: Record<string, number>; readOnly: boolean;
  onChange: (items: ItemForm[]) => void;
}) {
  const { items, onChange } = props;
  const set = (i: number, k: keyof ItemForm, v: string) =>
    onChange(items.map((it, n) => (n === i ? { ...it, [k]: v } : it)));
  const inp = (i: number, k: keyof ItemForm, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input value={items[i][k] ?? ""} onChange={(e) => set(i, k, e.target.value)} disabled={props.readOnly} {...extra} />
  );
  return (
    <div className="card">
      <div className="row"><h3>品目</h3>
        {!props.readOnly && <button type="button" onClick={() => onChange([...items, emptyItem()])}>行を追加</button>}
      </div>
      {items.map((it, i) => (
        <div key={it.id ?? i} className="item">
          <div className="grid">
            <label>品名 *{inp(i, "name", { required: true })}</label>
            <label>製番（空欄で自動）{inp(i, "product_no", { placeholder: "自動" })}</label>
            <label>客先品番{inp(i, "customer_part_no")}</label>
            <label>数量 *{inp(i, "quantity", { type: "number", step: "0.01", min: "0.01", required: true })}</label>
            <label>単位{inp(i, "unit")}</label>
            <label>販売単価（円）{inp(i, "sale_unit_price", { type: "number", step: "0.01", min: "0" })}</label>
            <label>原価単価（円）{inp(i, "cost_unit_price", { type: "number", step: "0.01", min: "0" })}</label>
            <label>納期{inp(i, "due_date", { type: "date" })}</label>
            <label>外注先（空欄=自社加工）
              <select value={it.vendor_id} onChange={(e) => set(i, "vendor_id", e.target.value)} disabled={props.readOnly}>
                <option value="">自社</option>
                {props.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
            <label className="wide">仕様（材質・板厚・寸法など）{inp(i, "spec")}</label>
          </div>
          <div className="row">
            <span>{it.id ? `金額 ${yen(props.amounts[it.id])}` : "金額は保存後に表示されます"}</span>
            {!props.readOnly && <button type="button" className="secondary" onClick={() => onChange(items.filter((_, n) => n !== i))}>この行を外す</button>}
          </div>
        </div>
      ))}
      {items.length === 0 && <p>品目がありません。「行を追加」またはAI取込で入力してください。</p>}
    </div>
  );
}
