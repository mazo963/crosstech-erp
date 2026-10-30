import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { pct, yen } from "../lib/format";

type Row = {
  total_order_amount: number; total_gross_profit: number; weighted_margin_pct: number | null;
  simple_avg_margin_pct: number | null; estimate_amount: number; ar_balance: number;
  overdue_amount: number; unbilled_amount: number;
};

export function Dashboard() {
  const [row, setRow] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("v_dashboard").select("*").single().then(({ data, error }) => {
      if (error) setError(error.message);
      else setRow(data as Row);
    });
  }, []);

  if (error) return <p className="error">読み込めません: {error}</p>;
  if (!row) return <p>読み込み中…</p>;

  const tiles: [string, string, boolean?][] = [
    ["総受注額", yen(row.total_order_amount)],
    ["総粗利", yen(row.total_gross_profit)],
    ["粗利率（加重平均）", pct(row.weighted_margin_pct)],
    ["粗利率（単純平均・参考）", pct(row.simple_avg_margin_pct)],
    ["見積中の金額", yen(row.estimate_amount)],
    ["未請求額", yen(row.unbilled_amount)],
    ["未回収残高", yen(row.ar_balance)],
    ["期日超過額", yen(row.overdue_amount), row.overdue_amount > 0],
  ];
  return (
    <div className="tiles">
      {tiles.map(([label, value, warn]) => (
        <div key={label} className={`card tile${warn ? " warn" : ""}`}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}
