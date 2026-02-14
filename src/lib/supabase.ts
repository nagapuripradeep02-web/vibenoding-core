import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
// Canonical name; also accept legacy SUPABASE_SERVICE_KEY for backward compat
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const VN_RUNTIME = process.env.VN_RUNTIME || 'prod';

export const supabaseConfigured: boolean = !!(supabaseUrl && supabaseServiceRoleKey);

/** Decode JWT payload role (no verification, just base64) — never leaks the secret */
function decodeJwtRole(jwt: string | undefined): string {
  if (!jwt) return 'missing';
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    return payload.role || 'unknown';
  } catch { return 'invalid'; }
}

export const supabaseRole: string = decodeJwtRole(supabaseServiceRoleKey);

// Startup diagnostics (safe — no secrets logged)
console.log(`[supabase] configured=${supabaseConfigured} role=${supabaseRole} runtime=${VN_RUNTIME}`);

if (supabaseConfigured && supabaseRole !== 'service_role') {
  console.warn(
    `[supabase] ⚠️  WARNING: SUPABASE_SERVICE_ROLE_KEY has role="${supabaseRole}", expected "service_role".\n` +
    `  This will cause RLS errors on INSERT/UPDATE. Check your .env file.`
  );
}

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
