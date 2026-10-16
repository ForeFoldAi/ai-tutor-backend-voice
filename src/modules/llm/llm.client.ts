import { Injectable, Logger } from "@nestjs/common";
import { config } from "../../config";

@Injectable()
export class LlmClient {
  private readonly log = new Logger(LlmClient.name);

  /** Always bounded: a hung call would otherwise block the session's turn queue forever. */
  async complete(
    messages: { role: string; content: string }[],
    maxTokens = 256,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    if (!config.llmApiKey) throw new Error("LLM_API_KEY missing");
    const started = Date.now();
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? config.llmTimeoutMs);
    const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.llmApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages,
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!res.ok) {
      const t = await res.text();
      this.log.warn(`llm ${res.status} ${t.slice(0, 200)}`);
      throw new Error("llm failed");
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    this.log.debug(`llm ${Date.now() - started}ms`);
    return (json.choices?.[0]?.message?.content || "").trim();
  }
}
