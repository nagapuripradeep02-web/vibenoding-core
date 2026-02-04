/**
 * LLM Router - Abstraction layer for different LLM providers
 * Phase 2: Start with OpenAI, can expand to other providers later
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean; // Force JSON response format
}

export interface LLMResponse {
  answer: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
}

export interface LLMError {
  error: string;
  status?: number;
  details?: string;
}

export type LLMResult = { ok: true; data: LLMResponse } | { ok: false; error: LLMError };

/**
 * Call OpenAI Chat Completions API
 */
async function callOpenAI(request: LLMRequest): Promise<LLMResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    return {
      ok: false,
      error: {
        error: 'OPENAI_API_KEY not configured',
        details: 'Set OPENAI_API_KEY in .env to use Ask mode',
      },
    };
  }

  const model = request.model || process.env.VN_ASK_MODEL || 'gpt-4o-mini';
  const temperature = request.temperature ?? 0.7;
  const maxTokens = request.maxTokens || 2000;

  try {
    const requestBody: Record<string, unknown> = {
      model,
      messages: request.messages,
      temperature,
      max_tokens: maxTokens,
    };

    // Enable JSON mode if requested (requires gpt-4o, gpt-4-turbo, or gpt-3.5-turbo-1106+)
    if (request.jsonMode) {
      requestBody.response_format = { type: 'json_object' };
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      return {
        ok: false,
        error: {
          error: 'OpenAI API error',
          status: response.status,
          details: errorText.slice(0, 500),
        },
      };
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      model: string;
    };

    const answer = data.choices?.[0]?.message?.content || '';

    return {
      ok: true,
      data: {
        answer,
        usage: data.usage ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        } : undefined,
        model: data.model,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        error: 'Failed to connect to OpenAI',
        details: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Main LLM router - routes requests to appropriate provider
 * Currently only supports OpenAI, can be extended later
 */
export async function callLLM(request: LLMRequest): Promise<LLMResult> {
  const provider = process.env.VN_LLM_PROVIDER || 'openai';

  switch (provider.toLowerCase()) {
    case 'openai':
      return callOpenAI(request);
    
    default:
      return {
        ok: false,
        error: {
          error: 'Unsupported LLM provider',
          details: `VN_LLM_PROVIDER=${provider} is not supported. Use 'openai'.`,
        },
      };
  }
}

/**
 * Estimate token count (rough approximation: 1 token ≈ 4 chars)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate text to fit within token budget
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  
  return text.slice(0, maxChars - 100) + '\n\n... (truncated)';
}
