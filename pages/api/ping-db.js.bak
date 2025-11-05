import { createClient } from "@supabase/supabase-js";
export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data, error } = await supabase.from("payments").select("id").limit(1);
  res.status(error ? 500 : 200).json({ ok: !error, error: error?.message, sample: data || [] });
}
