/**
 * クラスタ内 Ollama へのチャット呼び出し（imanect-labs fork）。
 *
 * 日本語ダイジェスト（`digest.ts`）とローカル翻訳（ワーカー側）で共有する。
 * 分けて書くと、下の base URL の解決規則という一番間違えやすい部分が
 * 2 か所に散る。
 */
import { Ollama } from "ollama";

import serverConfig from "./config";
import { customFetch } from "./customFetch";

/**
 * ローカル推論に使う Ollama の base URL。
 *
 * 埋め込みと同じサーバーを使い回す。`EMBEDDING_BASE_URL` を流用できるのは
 * `EMBEDDING_PROVIDER=ollama` のときだけ — openai 互換で使っている場合その
 * URL は `/v1` 付きで、Ollama のネイティブ `/api/chat` には当たらない。
 */
export function resolveLocalOllamaBaseUrl(): string | undefined {
  return (
    (serverConfig.embedding.provider === "ollama"
      ? serverConfig.embedding.baseUrl
      : undefined) ?? serverConfig.inference.ollamaBaseUrl
  );
}

export interface LocalChatOptions {
  /** JSON だけを返させる。翻訳では使わない。 */
  json?: boolean;
  temperature?: number;
  numCtx?: number;
  numPredict?: number;
  abortSignal?: AbortSignal;
}

export class LocalChatClient {
  /** 生成に使ったモデルの識別子。結果と一緒に保存して再生成の判定に使う。 */
  readonly modelId: string;
  private ollama: Ollama;

  constructor(
    baseUrl: string,
    private readonly model: string,
  ) {
    this.modelId = `ollama/${model}`;
    this.ollama = new Ollama({ host: baseUrl, fetch: customFetch });
  }

  async chat(
    system: string | null,
    user: string,
    opts: LocalChatOptions = {},
  ): Promise<string> {
    const response = await this.ollama.chat(
      {
        model: this.model,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: user },
        ],
        ...(opts.json ? { format: "json" as const } : {}),
        // **これが無いと qwen3.5 系は動かない。** ハイブリッド推論モデルで、
        // 既定では reasoning が num_predict を食い潰し出力が空になる
        // （実測 14/14 パース失敗 → think:false で 0/14）。推論を持たない
        // モデルではこのフラグは無視される。
        think: false,
        stream: false,
        options: {
          temperature: opts.temperature ?? 0.2,
          // VRAM 4GB の GPU では 4096 にすると ollama が OOM kill された。
          num_ctx: opts.numCtx ?? 2048,
          num_predict: opts.numPredict ?? 300,
        },
      },
      // AbortSignal は ollama の型に無いので options 経由では渡せない。
      // 呼び出し側はジョブのタイムアウトで打ち切られる。
    );
    return response.message.content;
  }
}

/** 設定が揃っていなければ null。呼び出し側は外部プロバイダに落とす。 */
export function buildLocalChatClient(model: string): LocalChatClient | null {
  const baseUrl = resolveLocalOllamaBaseUrl();
  return baseUrl ? new LocalChatClient(baseUrl, model) : null;
}
