import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type Staff = { id: string; name: string; role: "admin" | "office" | "viewer" };

/** ログイン状態と、staff に登録済みかどうか。未登録ユーザーは業務データに触れない（RLS）。 */
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [staff, setStaff] = useState<Staff | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setStaff(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    supabase.from("staff").select("id, name, role").eq("id", session.user.id).maybeSingle()
      .then(({ data }) => {
        setStaff((data as Staff | null) ?? null);
        setLoading(false);
      });
  }, [session]);

  return { session, staff, loading };
}
