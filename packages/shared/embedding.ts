/**
 * 埋め込み専用のプロバイダ（imanect-labs fork / FR-S-00）。
 *
 * upstream の `InferenceClientFactory` はプロバイダを 1 つしか選べず、
 * `generateEmbeddingFromText()` はチャットと同じ `OPENAI_BASE_URL` へ投げる。
 * その URL がチャット補完のリレー（OpenCode Go 等）だと `/embeddings` が無く、
 * 埋め込みは 1 件も作れない。ここではチャットと埋め込みで別のプロバイダを
 * 指せるようにする。
 *
 * `EMBEDDING_BASE_URL` を設定しなければ upstream と同じ挙動（推論プロバイダの
 * 使い回し）に落ちるので、この追加は既存構成を壊さない。
 */
import { Ollama } from "ollama";
import OpenAI from "openai";
import * as undici from "undici";

import serverConfig from "./config";
import { customFetch } from "./customFetch";
import type { EmbeddingResponse } from "./inference";
import {
  InferenceClientFactory,
  parseEmbeddingResponse,
  parseEmbeddingUsage,
} from "./inference";

export interface EmbeddingClient {
  /**
   * 埋め込みを作ったモデルの識別子（例 `ollama/embeddinggemma`）。
   * 候補ごとに記録して、モデルを差し替えたときに再計算対象を見分ける
   * （requirements.md §10）。異なる modelId のベクトルを同じ空間として
   * 比較してはいけない。
   */
  readonly modelId: string;
  generateEmbeddingFromText(inputs: string[]): Promise<EmbeddingResponse>;
}

class OpenAICompatibleEmbeddingClient implements EmbeddingClient {
  readonly modelId: string;
  private openAI: OpenAI;
  private model: string;

  constructor(config: {
    apiKey: string;
    baseURL?: string;
    proxyUrl?: string;
    timeoutSec?: number;
    model: string;
  }) {
    this.model = config.model;
    this.modelId = `openai/${config.model}`;
    this.openAI = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout:
        config.timeoutSec !== undefined ? config.timeoutSec * 1000 : undefined,
      defaultHeaders: {
        "X-Title": "Karakeep",
        "HTTP-Referer": "https://karakeep.app",
      },
      fetchOptions: config.proxyUrl
        ? { dispatcher: new undici.ProxyAgent(config.proxyUrl) }
        : undefined,
    });
  }

  async generateEmbeddingFromText(
    inputs: string[],
  ): Promise<EmbeddingResponse> {
    const response = await this.openAI.embeddings.create({
      model: this.model,
      input: inputs,
    });
    return {
      embeddings: parseEmbeddingResponse(response),
      ...parseEmbeddingUsage(response),
    };
  }
}

class OllamaEmbeddingClient implements EmbeddingClient {
  readonly modelId: string;
  private ollama: Ollama;
  private model: string;

  constructor(config: { baseUrl: string; model: string }) {
    this.model = config.model;
    this.modelId = `ollama/${config.model}`;
    this.ollama = new Ollama({
      host: config.baseUrl,
      fetch: customFetch,
    });
  }

  async generateEmbeddingFromText(
    inputs: string[],
  ): Promise<EmbeddingResponse> {
    const response = await this.ollama.embed({
      model: this.model,
      input: inputs,
      // 入力側で 2,048 トークンに収めているので通常ここには当たらない。
      // 当たった場合に例外で候補を落とすより、切り詰めてでも埋め込みを作る。
      truncate: true,
    });
    return {
      embeddings: response.embeddings,
      ...parseEmbeddingUsage(response),
    };
  }
}

/** 埋め込み専用の設定が無いときの、upstream 互換のフォールバック。 */
class InheritedEmbeddingClient implements EmbeddingClient {
  readonly modelId: string;
  private inner: {
    generateEmbeddingFromText(i: string[]): Promise<EmbeddingResponse>;
  };

  constructor(inner: {
    generateEmbeddingFromText(i: string[]): Promise<EmbeddingResponse>;
  }) {
    this.inner = inner;
    this.modelId = `inherited/${serverConfig.embedding.textModel}`;
  }

  generateEmbeddingFromText(inputs: string[]): Promise<EmbeddingResponse> {
    return this.inner.generateEmbeddingFromText(inputs);
  }
}

export class EmbeddingClientFactory {
  static build(): EmbeddingClient | null {
    const cfg = serverConfig.embedding;

    if (cfg.baseUrl) {
      // provider の既定が openai なのは、Ollama も `/v1/embeddings` を
      // OpenAI 互換で出すため。ネイティブ API を使いたいときだけ ollama を
      // 明示する（truncate オプションが渡せる）。
      const provider = cfg.provider ?? "openai";
      if (provider === "ollama") {
        return new OllamaEmbeddingClient({
          baseUrl: cfg.baseUrl,
          model: cfg.textModel,
        });
      }
      return new OpenAICompatibleEmbeddingClient({
        // ローカルの Ollama / TEI はキーを見ないが、OpenAI SDK は空文字を
        // 拒否するのでプレースホルダを入れる。
        apiKey: cfg.apiKey ?? "not-needed",
        baseURL: cfg.baseUrl,
        proxyUrl: serverConfig.inference.openAIProxyUrl,
        timeoutSec: serverConfig.inference.openAITimeoutSec,
        model: cfg.textModel,
      });
    }

    if (cfg.provider === "ollama" && serverConfig.inference.ollamaBaseUrl) {
      return new OllamaEmbeddingClient({
        baseUrl: serverConfig.inference.ollamaBaseUrl,
        model: cfg.textModel,
      });
    }

    const inference = InferenceClientFactory.build();
    return inference ? new InheritedEmbeddingClient(inference) : null;
  }

  /**
   * 埋め込み専用プロバイダが設定されているか。推薦機能はこれが true でないと
   * 動かないので、起動時の診断に使う。
   */
  static hasDedicatedProvider(): boolean {
    return !!serverConfig.embedding.baseUrl;
  }
}
