/**
 * Briefing の日本語ダイジェスト（imanect-labs fork / FR-U-13）。
 *
 * 呼び出しの本体（本文取得・DB 書き戻し）はワーカー側にあり、ここには
 * プロンプトと推論クライアントだけを置く。`embedding.ts` と同じ理由で、
 * `ollama` パッケージへの依存をこのパッケージに閉じ込めたい。
 */
import { z } from "zod";

import serverConfig from "./config";
import { InferenceClientFactory } from "./inference";
import { buildLocalChatClient } from "./localChat";

/**
 * ベンチで 14/14 成功した版そのまま。4 行目と 5 行目は実測の失敗に対する
 * 個別の手当てなので、短くしないこと。
 *
 * - 中国語語彙の禁止: qwen 系は「治理」「信息」「产品线」を平気で混ぜる
 * - 「BODY が断片でも必ず要約を書く」: 「情報が不足していたら空にする」と
 *   書いた版では、本文が短い記事の要約が軒並み空になった
 */
export const DIGEST_SYSTEM_PROMPT = `あなたは技術記事の要約者です。与えられた記事の情報から、日本語のタイトル訳と要約を作ります。
規則:
- title_ja: 記事タイトルの自然な日本語訳。元が日本語ならそのまま返す。固有名詞・製品名・技術用語は原語のまま残す。
- summary_ja: 本文情報にもとづく日本語の要約。2〜3文、120字以内。事実のみを書き、推測や感想は書かない。
- 日本語として自然な語彙を使う。中国語の語彙(治理・信息など)は使わない。governance はガバナンス。
- BODY が「(本文情報なし)」のときだけ summary_ja を空文字にする。それ以外は BODY が断片でも、TITLE と BODY から分かる範囲で必ず要約を書く。
- JSON オブジェクトのみを出力する。前後に説明を書かない。`;

export const NO_BODY_PLACEHOLDER = "(本文情報なし)";

export function buildDigestUserPrompt(input: {
  title: string | null;
  url: string;
  body: string;
}): string {
  return [
    `TITLE: ${input.title ?? ""}`,
    `URL: ${input.url}`,
    `BODY: ${input.body.trim() || NO_BODY_PLACEHOLDER}`,
  ].join("\n");
}

const digestSchema = z.object({
  title_ja: z.string(),
  summary_ja: z.string(),
});

export interface ParsedDigest {
  titleJa: string;
  summaryJa: string | null;
}

/**
 * `format: "json"` を付けても、モデルはコードフェンスや前置きを足すことが
 * ある。最初の `{` から最後の `}` までを切り出して読む。
 */
export function parseDigestResponse(raw: string): ParsedDigest | null {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = digestSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const titleJa = parsed.data.title_ja.trim();
  if (!titleJa) {
    // 訳題が空なら成功と見なさない。原題を出したほうがまだ読める。
    return null;
  }
  const summaryJa = parsed.data.summary_ja.trim();
  return { titleJa, summaryJa: summaryJa || null };
}

export interface DigestClient {
  /** 生成に使ったモデルの識別子。再生成の判定に使うので候補行に残す。 */
  readonly modelId: string;
  complete(system: string, user: string): Promise<string>;
}

export function buildDigestClient(): DigestClient | null {
  const cfg = serverConfig.recommender.digest;

  if (cfg.provider === "off") {
    return null;
  }

  if (cfg.provider === "local") {
    // 埋め込みと同じ Ollama を使う。埋め込みは 04:00、ダイジェストは
    // rank（05:30）の後なので、OLLAMA_MAX_LOADED_MODELS=1 でも競合しない。
    const local = buildLocalChatClient(cfg.model);
    if (!local) {
      return null;
    }
    return {
      modelId: local.modelId,
      complete: (system, user) =>
        local.chat(system, user, { json: true, numPredict: 300 }),
    };
  }

  const inference = InferenceClientFactory.build();
  if (!inference) {
    return null;
  }
  return {
    modelId: `external/${serverConfig.inference.textModel}`,
    complete: async (system, user) => {
      const response = await inference.inferFromText(`${system}\n\n${user}`, {
        schema: digestSchema,
      });
      return response.response;
    },
  };
}
