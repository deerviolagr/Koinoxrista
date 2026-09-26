import { Logger } from '@nestjs/common';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmProvider {
  /** Name used for logging/metrics. */
  readonly name: string;
  /**
   * Returns the assistant's answer for the given building-scoped context.
   * Implementations must not leak data across buildings — the context is
   * already filtered by the caller.
   */
  complete(system: string, user: string): Promise<string>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
export const DEFAULT_LLM_TIMEOUT_MS = 15_000;
const MAX_LLM_TIMEOUT_MS = 120_000;

export function isAiLocalOnly(): boolean {
  return (process.env.AI_LOCAL_ONLY ?? '').trim().toLowerCase() === 'true';
}

function configuredTimeoutMs(): number {
  const raw = Number(
    process.env.LLM_TIMEOUT_MS ??
      process.env.AI_REQUEST_TIMEOUT_MS ??
      process.env.AI_LLM_TIMEOUT_MS ??
      DEFAULT_LLM_TIMEOUT_MS,
  );
  if (!Number.isFinite(raw)) return DEFAULT_LLM_TIMEOUT_MS;
  return Math.min(MAX_LLM_TIMEOUT_MS, Math.max(1, Math.floor(raw)));
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * Strict local-endpoint policy for AI_LOCAL_ONLY.  A configured URL is not
 * trusted merely because it implements an OpenAI-compatible API: a hostname
 * such as `https://llm.example.com` would still exfiltrate building context.
 * Loopback, Docker-style local names, and RFC1918/link-local addresses are
 * accepted; public DNS names and public IPs are not.
 */
export function isLocalLlmUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost' ||
    hostname === 'ollama' ||
    hostname === 'host.docker.internal' ||
    hostname.endsWith('.local')
  ) {
    return true;
  }
  if (hostname === '::1' || hostname === '0.0.0.0') return true;
  return isPrivateIpv4(hostname);
}

export function assertLocalLlmUrl(value: string): void {
  if (!isLocalLlmUrl(value)) {
    throw new Error(
      'AI_LOCAL_ONLY=true permits only a local OpenAI-compatible endpoint; refusing remote URL',
    );
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = configuredTimeoutMs(),
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`LLM request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    // Promise.race also protects against fetch implementations/test doubles
    // that fail to observe AbortSignal themselves.
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Console/offline provider (Feature 17 default). It deliberately logs only
 * metadata, never the prompt or retrieved context.
 */
export class ConsoleLlmProvider implements LlmProvider {
  readonly name = 'console';
  private readonly logger = new Logger(ConsoleLlmProvider.name);

  async complete(_system: string, user: string): Promise<string> {
    this.logger.log(`[assistant][mock] query length=${user.length}`);
    return (
      'Η απάντηση δεν είναι διαθέσιμη από το τοπικό μοντέλο αυτή τη στιγμή. ' +
      'Δοκιμάστε ξανά ή συμβουλευτείτε τις Ανακοινώσεις του κτιρίου και τη σελίδα FAQ. ' +
      '(Λειτουργία τοπικού AI — τα δεδομένα σας δεν στάλθηκαν εκτός ΕΕ.)'
    );
  }
}

/**
 * Native OpenAI Chat Completions provider.
 * Env: OPENAI_API_KEY (required), OPENAI_MODEL (default gpt-4o-mini),
 * OPENAI_BASE_URL (optional; e.g. an OpenAI-compatible gateway or Azure URL).
 */
export class OpenAiLlmProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly logger = new Logger(OpenAiLlmProvider.name);

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async complete(system: string, user: string): Promise<string> {
    if (isAiLocalOnly()) {
      throw new Error('Hosted OpenAI provider is disabled by AI_LOCAL_ONLY');
    }
    const messages: LlmMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    const res = await fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: 1024,
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      this.logger.warn(`OpenAI request failed (${res.status})`);
      throw new Error(`OpenAI request failed (${res.status})`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) {
      throw new Error('OpenAI returned an empty response');
    }
    return text;
  }
}

/**
 * Native Anthropic Messages API provider.
 * Env: ANTHROPIC_API_KEY (required), ANTHROPIC_MODEL (default
 * claude-3-5-sonnet-20241022).
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly logger = new Logger(AnthropicLlmProvider.name);

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = 'https://api.anthropic.com/v1',
  ) {}

  async complete(system: string, user: string): Promise<string> {
    if (isAiLocalOnly()) {
      throw new Error('Hosted Anthropic provider is disabled by AI_LOCAL_ONLY');
    }
    const res = await fetchWithTimeout(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        system,
        max_tokens: 1024,
        temperature: 0.3,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) {
      this.logger.warn(`Anthropic request failed (${res.status})`);
      throw new Error(`Anthropic request failed (${res.status})`);
    }
    const data = (await res.json()) as {
      content?: { type?: string; text?: string }[];
    };
    const text = (data.content ?? [])
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text as string)
      .join('\n')
      .trim();
    if (!text) {
      throw new Error('Anthropic returned an empty response');
    }
    return text;
  }
}

/**
 * Generic OpenAI-compatible endpoint (self-hosted/one/api/ollama/vLLM gateway).
 * Env: LLM_API_URL (required), LLM_API_KEY, LLM_MODEL.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai-compatible';
  private readonly logger = new Logger(OpenAiCompatibleProvider.name);

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly url: string,
  ) {
    if (isAiLocalOnly()) {
      assertLocalLlmUrl(url);
    }
  }

  async complete(system: string, user: string): Promise<string> {
    if (isAiLocalOnly()) assertLocalLlmUrl(this.url);
    const res = await fetchWithTimeout(this.url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      this.logger.warn(`LLM request failed (${res.status})`);
      throw new Error(`LLM request failed (${res.status})`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) {
      throw new Error('LLM returned an empty response');
    }
    return text;
  }
}

export type LlmProviderKind = 'console' | 'openai' | 'anthropic' | 'openai-compatible';

/**
 * Selects a provider from configuration. Explicit `LLM_PROVIDER` wins; when set
 * to `auto` (default) we pick the first fully-configured provider. A requested
 * provider whose key is missing logs a warning and falls back to console
 * rather than crashing the module at boot. In local-only mode, every hosted
 * path and every public compatible URL is rejected.
 */
export function createLlmProvider(): LlmProvider {
  const logger = new Logger('LlmProvider');
  const explicit = (process.env.LLM_PROVIDER ?? 'auto')
    .toLowerCase()
    .trim() as LlmProviderKind | 'auto';
  const localOnly = isAiLocalOnly();

  const openaiKey = process.env.OPENAI_API_KEY ?? '';
  const openaiModel = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  const openaiBaseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';

  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
  const anthropicModel =
    process.env.ANTHROPIC_MODEL ?? 'claude-3-5-sonnet-20241022';

  const compatUrl = process.env.LLM_API_URL ?? '';
  const compatKey = process.env.LLM_API_KEY ?? '';
  const compatModel = process.env.LLM_MODEL ?? 'meltemi:7b';
  const localCompatUrl = compatUrl && (!localOnly || isLocalLlmUrl(compatUrl));

  const compatible = (): LlmProvider =>
    new OpenAiCompatibleProvider(compatKey, compatModel, compatUrl);

  const pick = (): LlmProvider => {
    if (localOnly) {
      if (localCompatUrl) return compatible();
      if (compatUrl) {
        logger.warn('AI_LOCAL_ONLY=true — refusing remote OpenAI-compatible URL; using console fallback');
      } else {
        logger.log('AI_LOCAL_ONLY=true — hosted LLM disabled, using console/local fallback');
      }
      return new ConsoleLlmProvider();
    }
    if (anthropicKey) return new AnthropicLlmProvider(anthropicKey, anthropicModel);
    if (openaiKey) return new OpenAiLlmProvider(openaiKey, openaiModel, openaiBaseUrl);
    if (compatUrl) return compatible();
    return new ConsoleLlmProvider();
  };

  switch (explicit) {
    case 'console':
      return new ConsoleLlmProvider();
    case 'openai':
      if (localOnly) {
        logger.warn('AI_LOCAL_ONLY=true — hosted openai disabled, using local/console');
        return localCompatUrl ? compatible() : new ConsoleLlmProvider();
      }
      if (openaiKey) return new OpenAiLlmProvider(openaiKey, openaiModel, openaiBaseUrl);
      logger.warn('LLM_PROVIDER=openai but OPENAI_API_KEY is missing; using console mock');
      return new ConsoleLlmProvider();
    case 'anthropic':
      if (localOnly) {
        logger.warn('AI_LOCAL_ONLY=true — hosted anthropic disabled, using local/console');
        return localCompatUrl ? compatible() : new ConsoleLlmProvider();
      }
      if (anthropicKey) {
        return new AnthropicLlmProvider(anthropicKey, anthropicModel);
      }
      logger.warn('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing; using console mock');
      return new ConsoleLlmProvider();
    case 'openai-compatible':
      if (localOnly && !localCompatUrl) {
        logger.warn('AI_LOCAL_ONLY=true — refusing remote compatible URL; using console mock');
        return new ConsoleLlmProvider();
      }
      if (compatUrl) return compatible();
      logger.warn('LLM_PROVIDER=openai-compatible but LLM_API_URL is missing; using console mock');
      return new ConsoleLlmProvider();
    case 'auto':
    default:
      return pick();
  }
}
