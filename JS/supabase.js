const SUPABASE_URL = "https://nekxpfooskfxeafbpjqp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5la3hwZm9vc2tmeGVhZmJwanFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwODA0ODAsImV4cCI6MjA5NTY1NjQ4MH0.mT4edn1tHVG9O5oHqHKv1vaRRx3ufJK1Ru8_J2CbTQI";

function getAzulSupabaseOrganizationHeader() {
  try {
    return localStorage.getItem("azul_organization_id") || "";
  } catch (e) {
    return "";
  }
}

function createAzulSupabaseFetch() {
  var nativeFetch = window.fetch.bind(window);

  return function(input, init) {
    init = init || {};
    var headers = new Headers(init.headers || {});
    
    // Vérifier si la requête cible l'authentification Supabase pour ne pas la perturber
    var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    var isAuthRoute = url && url.includes('/auth/v1/');

    if (!isAuthRoute) {
      var organizationId = getAzulSupabaseOrganizationHeader();
      if (organizationId) {
        headers.set("x-organization-id", organizationId);
      } else {
        headers.delete("x-organization-id");
      }
    }

    init.headers = headers;
    return nativeFetch(input, init);
  };
}

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: window.localStorage
  },
  global: {
    fetch: createAzulSupabaseFetch()
  }
});
