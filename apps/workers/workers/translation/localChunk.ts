import serverConfig from "@karakeep/shared/config";
import type { LocalChatClient } from "@karakeep/shared/localChat";
import { buildLocalChatClient } from "@karakeep/shared/localChat";
import logger from "@karakeep/shared/logger";

import {
  applySegments,
  decodeEntities,
  encodeEntities,
  extractInlineSegments,
  maskInlineTags,
  restoreInlineTags,
} from "./textNodes";
import { cjkRatio } from "./validate";

/**
 * ローカル LLM に**素テキストだけ**を渡してチャンクを訳す。
 *
 * 外部プロバイダ経路（`translate.ts` の既定）は HTML を丸ごと渡して
 * 「タグを変えるな」と指示し、結果を検証・再サンプリングしている。
 * ローカルの 4B 級はこれが通らない（`textNodes.ts` 冒頭の実測を参照）ので、
 * タグの保存はモデルではなくコードで担保する。
 *
 * 単位はブロック（段落・リスト項目・見出し）。文中の `<a>` や `<code>` は
 * `[0]` のようなプレースホルダにして**文のまま**渡す。テキストノードごとに
 * 分けて渡す実装も試したが、断片を受け取ったモデルが「1987年」「1つ選んで
 * チェックしてください」のような接続詞ごとの捏造を返し、同じ段落に日本語と
 * 英語が混ざって明確に悪化したので採らなかった。
 */
export interface LocalTranslationStats {
  segments: number;
  translated: number;
  /** すでに日本語だったので触らなかったセグメント。 */
  skipped: number;
  /** モデルが使える訳文を返さず、原文のまま残したセグメント。 */
  failed: number;
  /** 文中タグを戻せず、原文のまま残したセグメント。 */
  degraded: number;
}

export function buildLocalTranslator(): LocalChatClient | null {
  return buildLocalChatClient(serverConfig.translation.localModel);
}

/**
 * 訳文の後始末。
 *
 * CAT-Translate は出力末尾に `</s>` を漏らす（実測）。前置きを書くことも
 * あるので **改行は捨てて 1 行に潰す** — 元がブロック 1 つなので訳文も
 * 1 つのテキストであるべきで、行が増えているのはモデルが余計なことを
 * 書いた合図。
 */
export function cleanTranslatedText(raw: string): string {
  return raw
    .replace(/<\/?s>/g, "")
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 訳文として採用してよいか。
 *
 * 採用しない場合は原文をそのまま残す。訳せていない箇所が英語で残るほうが、
 * 捏造された日本語が混ざるより読者にとって害が少ない。
 */
export function isUsableTranslation(
  source: string,
  translated: string,
  targetIsJapanese: boolean,
): boolean {
  if (!translated) {
    return false;
  }
  // 短い断片ほどモデルは暴走しやすい。原文の 3 倍を超える出力はまず幻覚。
  if (translated.length > Math.max(80, source.length * 3)) {
    return false;
  }
  if (targetIsJapanese && source.length > 40 && cjkRatio(translated) < 0.05) {
    // 訳したつもりで英語のまま返ってきた。
    return false;
  }
  if (
    source.length < SHORT_FRAGMENT_CHARS &&
    hasInventedDigits(source, translated)
  ) {
    return false;
  }
  return true;
}

/**
 * 短い断片に対しては、原文に無い数字が出てきたら捨てる。
 *
 * 実測での代表的な壊れ方がこれ。`get ` のような断片を渡すと
 * 「1つ追加できます」「1987年」のように**数字ごと捏造する**。長い文では
 * "ten times" → 「10倍」のような正当な変換があるので、短い断片に限る。
 */
const SHORT_FRAGMENT_CHARS = 40;

export function hasInventedDigits(source: string, translated: string): boolean {
  const inSource = new Set(source.match(/\d+/g) ?? []);
  for (const n of translated.match(/\d+/g) ?? []) {
    if (!inSource.has(n)) {
      return true;
    }
  }
  return false;
}

export function buildPrompt(targetLang: string, text: string): string {
  // 翻訳特化モデル（CAT-Translate 等）は長い指示を理解しない。命令 1 行 +
  // 本文という最小の形が最も安定する（実測）。プレースホルダの説明は
  // あえて書かない — 書くとモデルが記号について解説を始めることがある。
  return `Translate the following text into ${targetLang}. Output only the translation.\n\n${text}`;
}

export async function translateChunkLocally(
  client: LocalChatClient,
  chunk: string,
  targetLang: string,
  opts: { jobId: string } = { jobId: "-" },
): Promise<{ html: string; stats: LocalTranslationStats }> {
  const segments = extractInlineSegments(chunk);
  const targetIsJapanese = targetLang.trim().toLowerCase() === "japanese";
  const stats: LocalTranslationStats = {
    segments: segments.length,
    translated: 0,
    skipped: 0,
    failed: 0,
    degraded: 0,
  };

  // 同じ文字列は 1 回だけ訳す。ナビゲーションやキャプションは 1 本の記事の
  // 中で何度も出る。
  const cache = new Map<string, string | null>();
  const replacements: (string | null)[] = [];

  for (const segment of segments) {
    // 訳す対象が無い（コードとリンクだけのリスト項目など）か、本文に
    // プレースホルダと紛らわしい並びがあって安全に隠せない。どちらも
    // 原文をそのまま残すのが正しい。
    const masked = maskInlineTags(segment.raw);
    if (!masked) {
      stats.skipped++;
      replacements.push(null);
      continue;
    }

    const source = decodeEntities(masked.masked);
    if (targetIsJapanese && cjkRatio(source) > 0.3) {
      // すでに日本語。訳し直すと表記が揺れるだけ。
      stats.skipped++;
      replacements.push(null);
      continue;
    }

    // プレースホルダが崩れるのは呼び出しごとの揺れなので、引き直すと通る
    // ことがある。外部経路と同じ TRANSLATION_MAX_CHUNK_ATTEMPTS を使う。
    let restored: string | null = null;
    let translated: string | null = null;
    const attempts = cache.has(source)
      ? 1
      : serverConfig.translation.maxChunkAttempts;
    for (let attempt = 1; attempt <= attempts && restored === null; attempt++) {
      translated = cache.has(source)
        ? cache.get(source)!
        : await translateOne(
            client,
            source,
            targetLang,
            targetIsJapanese,
            opts.jobId,
          );
      if (translated === null) {
        break;
      }
      restored = restoreInlineTags(encodeEntities(translated), masked.tokens);
      if (restored !== null) {
        cache.set(source, translated);
      }
    }

    if (translated === null) {
      stats.failed++;
      replacements.push(null);
      continue;
    }

    if (restored === null) {
      // プレースホルダを元どおり戻せなかった。原文をそのまま残す。
      //
      // ここでテキストノード単位の訳に落とす案も試したが、**出力が明確に
      // 悪くなった**ので採らない: 文の断片を単独で渡すとモデルが
      // 「1つ選んでチェックしてください」のような接続詞ごと捏造した文を
      // 返し、日本語と英語が同じ段落に混ざる。段落まるごと英語で残るほうが
      // 読者にとって害が少ない。
      stats.degraded++;
      replacements.push(null);
      continue;
    }

    stats.translated++;
    replacements.push(masked.leading + restored + masked.trailing);
  }

  return { html: applySegments(chunk, segments, replacements), stats };
}

async function translateOne(
  client: LocalChatClient,
  source: string,
  targetLang: string,
  targetIsJapanese: boolean,
  jobId: string,
): Promise<string | null> {
  try {
    const raw = await client.chat(null, buildPrompt(targetLang, source), {
      temperature: 0.1,
      numCtx: 2048,
      numPredict: serverConfig.translation.localMaxTokens,
    });
    const cleaned = cleanTranslatedText(raw);
    return isUsableTranslation(source, cleaned, targetIsJapanese)
      ? cleaned
      : null;
  } catch (e) {
    logger.warn(
      `[translation][${jobId}] local translation call failed: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}
