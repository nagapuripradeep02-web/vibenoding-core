import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VN_RUNTIME = process.env.VN_RUNTIME || 'prod';

export const supabaseConfigured: boolean = !!(supabaseUrl && supabaseServiceRoleKey);

// Prod: fail fast at boot. CI: defer to request time.
if (!supabaseConfigured && VN_RUNTIME !== 'ci') {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable'
  );
}

// Guarded proxy: throws deterministic 503 on any access when not configured
function createSupabaseStub(): SupabaseClient {
  return new Proxy({} as SupabaseClient, {
    get(_target, prop) {
      // Allow typeof checks and toJSON without throwing
      if (prop === Symbol.toPrimitive || prop === 'toJSON') return undefined;
      const err: any = new Error('supabase_not_configured');
      err.statusCode = 503;
      throw err;
    },
  });
}

export const supabaseAdmin: SupabaseClient = supabaseConfigured
  ? createClient(supabaseUrl!, supabaseServiceRoleKey!, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
  : createSupabaseStub();

/** Guard helper — throws 503 if Supabase is not configured */
export function requireSupabase(): SupabaseClient {
  if (!supabaseConfigured) {
    const err: any = new Error('supabase_not_configured');
    err.statusCode = 503;
    throw err;
  }
  return supabaseAdmin;
}
