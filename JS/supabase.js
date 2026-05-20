const SUPABASE_URL = "https://gtgfdxdximyshlusgyit.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_5-KzyXN60M6QZtrG482f-g_xQ32WikV";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: {
    headers: {
      "x-organization-id": localStorage.getItem("azul_organization_id") || ""
    }
  }
});
