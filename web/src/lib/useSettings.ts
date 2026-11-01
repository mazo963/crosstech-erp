import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";

export type Settings = {
  company_name: string; invoice_reg_no: string | null; postal_code: string | null; address: string | null; tel: string | null; email: string | null;
  bank_info: string | null; tax_rounding: string; erp_invoice_official: boolean; box_import_email: string | null; mail_signature: string | null; own_timestamp: boolean;
  fax: string | null; contact_person: string | null; quote_valid_days: number; logo_data: string | null; seal_data: string | null;
};

/** 自社情報・設定（company_settings の1行）。 */
export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const reload = useCallback(() => {
    supabase.from("company_settings").select("*").eq("id", 1).single().then(({ data }) => setSettings((data as Settings) ?? null));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { settings, reload };
}
