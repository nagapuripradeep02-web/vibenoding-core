type SanitizeOptions = {
  maxDepth?: number;
  maxKeys?: number;
  maxArrayLength?: number;
  maxStringLength?: number;
  maxBytes?: number;
};

const DEFAULTS: Required<SanitizeOptions> = {
  maxDepth: 6,
  maxKeys: 200,
  maxArrayLength: 25,
  maxStringLength: 500,
  maxBytes: 12000,
};

const SECRET_KEY_RE = /(secret|token|api[_-]?key|password|authorization|cookie|set-cookie|client_secret|access[_-]?token|refresh[_-]?token)/i;

function truncateStringSafe(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}â€¦(truncated ${s.length - max} chars)`;
}

function redactString(s: string): string {
  if (/^Bearer\s+/i.test(s)) return 'Bearer [REDACTED]';
  if (s.length > 2000) return `${s.slice(0, 20)}â€¦[REDACTED_LONG_STRING]`;
  return s;
}

function sanitizeInner(value: unknown, opts: Required<SanitizeOptions>, depth: number, keyBudget: { left: number }): unknown {
  if (value === null || value === undefined) return null;
  if (depth > opts.maxDepth) return '[TRUNCATED_DEPTH]';

  const t = typeof value;
  if (t === 'string') return truncateStringSafe(redactString(value as string), opts.maxStringLength);
  if (t === 'number' || t === 'boolean') return value;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    const n = Math.min(value.length, opts.maxArrayLength);
    for (let i = 0; i < n; i++) {
      out.push(sanitizeInner(value[i], opts, depth + 1, keyBudget));
    }
    if (value.length > n) out.push(`[TRUNCATED_ARRAY length=${value.length}]`);
    return out;
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(obj);
    const n = Math.min(keys.length, Math.min(opts.maxKeys, keyBudget.left));

    for (let i = 0; i < n; i++) {
      const k = keys[i];
      keyBudget.left -= 1;
      if (SECRET_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeInner(obj[k], opts, depth + 1, keyBudget);
      }
      if (keyBudget.left <= 0) break;
    }

    if (keys.length > n) {
      out._truncated = `[TRUNCATED_OBJECT keys=${keys.length}]`;
    }

    return out;
  }

  return String(value);
}

export function sanitizeForResponse(value: unknown, options?: SanitizeOptions): unknown {
  const opts: Required<SanitizeOptions> = { ...DEFAULTS, ...(options || {}) };
  const sanitized = sanitizeInner(value, opts, 0, { left: opts.maxKeys });

  try {
    const json = JSON.stringify(sanitized);
    if (Buffer.byteLength(json, 'utf8') <= opts.maxBytes) return sanitized;
    const truncated = truncateStringSafe(json, opts.maxBytes);
    return { _truncated_json: truncated };
  } catch {
    return '[UNSERIALIZABLE]';
  }
}
