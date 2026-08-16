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

/**
 * 複数件を 1 回の呼び出しでまとめて作らせる版。外部プロバイダ専用。
 *
 * 単発版との差は 3 行目まで。**出力の形をここに書いておくこと。**
 * `response_format: json_schema` (strict) を付けても効かないプロバイダが
 * あり、実測 (OpenCode Go / mimo-v2.5) では `{"items": [...]}` を要求した
 * のに `{"1": {...}, "2": {...}}` が返ってきた。形の指示をプロンプトに
 * 書いた回は `items` で安定したが、それでも `parseBatchDigestResponse` は
 * 両方を読めるようにしてある。
 */
export const DIGEST_BATCH_SYSTEM_PROMPT = `あなたは技術記事の要約者です。ID 付きで複数の記事が与えられます。記事ごとに日本語のタイトル訳と要約を作ります。
規則:
- 出力は {"items": [{"id": <入力のID>, "title_ja": "...", "summary_ja": "..."}, ...]} という形の JSON オブジェクトだけにする。
- 入力の記事すべてに 1 件ずつ返す。ID は入力のものをそのまま返す。件数を減らさない。
- 記事どうしの情報を混ぜない。ある記事の要約に別の記事の内容を書かない。
- title_ja: 記事タイトルの自然な日本語訳。元が日本語ならそのまま返す。固有名詞・製品名・技術用語は原語のまま残す。
- summary_ja: その記事の BODY にもとづく日本語の要約。2〜3文、120字以内。事実のみを書き、推測や感想は書かない。
- 日本語として自然な語彙を使う。中国語の語彙(治理・信息など)は使わない。governance はガバナンス。
- BODY が「(本文情報なし)」のときだけ summary_ja を空文字にする。それ以外は BODY が断片でも、TITLE と BODY から分かる範囲で必ず要約を書く。
- JSON オブジェクトのみを出力する。前後に説明を書かない。`;

export const NO_BODY_PLACEHOLDER = "(本文情報なし)";

export interface DigestInput {
  title: string | null;
  url: string;
  body: string;
}

export function buildDigestUserPrompt(input: DigestInput): string {
  return [
    `TITLE: ${input.title ?? ""}`,
    `URL: ${input.url}`,
    `BODY: ${input.body.trim() || NO_BODY_PLACEHOLDER}`,
  ].join("\n");
}

/**
 * バッチの入力。ID は**配列の位置 + 1**で、呼び出し側の行と対応づける。
 * URL や候補 ID を使わないのは、長い ID をモデルに書き写させると写し間違いが
 * 混ざるため。1 始まりの整数なら取り違えても検出できる。
 */
export function buildBatchDigestUserPrompt(inputs: DigestInput[]): string {
  return inputs
    .map((input, i) => `[${i + 1}]\n${buildDigestUserPrompt(input)}`)
    .join("\n---\n");
}

const digestSchema = z.object({
  title_ja: z.string(),
  summary_ja: z.string(),
});

export const batchDigestSchema = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      title_ja: z.string(),
      summary_ja: z.string(),
    }),
  ),
});

export interface ParsedDigest {
  titleJa: string;
  summaryJa: string | null;
}

/**
 * `format: "json"` を付けても、モデルはコードフェンスや前置きを足すことが
 * ある。最初の `{`（バッチでは `[`）から最後の閉じ括弧までを切り出して読む。
 */
function extractJson(raw: string, open: "{" | "[" = "{"): unknown {
  const close = open === "{" ? "}" : "]";
  const text = raw.trim();
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export function parseDigestResponse(raw: string): ParsedDigest | null {
  const value = extractJson(raw);
  if (value === undefined) {
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

/**
 * バッチ応答を ID → ダイジェストの Map にする。
 *
 * **1 件も読めなくても例外にしない。** 呼び出し側は欠けた ID を単発で
 * 作り直すので、ここは「読めたものだけ返す」で足りる。実測で確認した
 * 3 つの形をすべて受ける:
 *
 *   {"items": [{"id": 1, ...}]}   … プロンプトどおり
 *   {"results": [{"id": 1, ...}]} … キー名だけ違う
 *   {"1": {...}, "2": {...}}      … ID をキーにした object
 *   [{"id": 1, ...}]              … 素の配列
 *
 * 全体が JSON として読めないときは、**中の項目だけを拾い直す** (サルベージ)。
 * 応答が途中で切れると外側の `}` が来ないので JSON.parse が丸ごと落ちるが、
 * 切れる前の項目は完全な形で入っている。本番で 10 件中 1 件も読めずに
 * 単発 10 回へ落ちたことが 2 回あり、どちらもここで救える形だった。
 */
export function parseBatchDigestResponse(
  raw: string,
): Map<number, ParsedDigest> {
  const text = raw.trim();
  // 素の配列で返ってくることがあるので、`[` が先に来ていたら配列として読む。
  const objectAt = text.indexOf("{");
  const arrayAt = text.indexOf("[");
  const value =
    arrayAt !== -1 && (objectAt === -1 || arrayAt < objectAt)
      ? (extractJson(text, "[") ?? extractJson(text, "{"))
      : (extractJson(text, "{") ?? extractJson(text, "["));

  const entries =
    value !== undefined && value !== null && typeof value === "object"
      ? collectBatchEntries(value)
      : [];
  const result = buildDigests(entries);
  if (result.size > 0) {
    return result;
  }
  return buildDigests(salvageBatchEntries(text));
}

function buildDigests(entries: [number, unknown][]): Map<number, ParsedDigest> {
  const result = new Map<number, ParsedDigest>();
  for (const [id, item] of entries) {
    const parsed = digestSchema.safeParse(item);
    if (!parsed.success) {
      continue;
    }
    const titleJa = parsed.data.title_ja.trim();
    if (!titleJa) {
      continue;
    }
    const summaryJa = parsed.data.summary_ja.trim();
    // 簡体字が混ざったものは**読めなかった扱いにする**。呼び出し側が単発で
    // 作り直し、単発なら実測で出ない (下記)。
    if (hasSimplifiedOnlyChars(titleJa) || hasSimplifiedOnlyChars(summaryJa)) {
      continue;
    }
    result.set(id, { titleJa, summaryJa: summaryJa || null });
  }
  return result;
}

/**
 * 壊れた応答から項目だけを拾う。
 *
 * **ID を持つ項目しか拾わない。** 全体が読めている通常経路では「配列の位置」で
 * ID を補えるが、途中で切れた応答では何件目まで来ているのか保証が無い。
 * 位置で補うと別の記事の要約を書き込みかねないので、ここでは諦めて単発の
 * 作り直しに回す。
 */
function salvageBatchEntries(text: string): [number, unknown][] {
  const entries: [number, unknown][] = [];
  for (const object of scanBalancedObjects(text)) {
    const id = readItemId(object);
    if (id !== null) {
      entries.push([id, object]);
    }
  }
  return entries;
}

/**
 * 文字列中の「対応が取れている `{...}`」をすべて読む。入れ子の内側から
 * 閉じるので、外側が閉じていなくても中の項目は拾える。
 */
function scanBalancedObjects(text: string): unknown[] {
  const found: unknown[] = [];
  const starts: number[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      starts.push(i);
    } else if (ch === "}") {
      const start = starts.pop();
      if (start !== undefined) {
        try {
          found.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // 中に壊れた項目があるだけ。他の項目は拾える。
        }
      }
    }
  }
  return found;
}

/**
 * 日本語では使わない簡体字。**バッチのときだけ混ざる。**
 *
 * mimo-v2.5 の本番出力 50 件で 2 件 (中间・时)、切り分けでも 10 件バッチ 3 回で
 * 1 件出た。同じ記事を単発で 3 回ずつ投げると 6/6 とも出ない。プロンプトの
 * 「中国語の語彙を使わない」が、記事 10 件ぶんの入力に薄められて効かなくなる。
 *
 * 「日本語に無い字が 1 つでもあれば作り直す」だけの雑な判定にしてある。
 * 拾い漏らしても実害は「その 1 件が中国語混じりで出る」だけで、逆に
 * 誤検出しても単発で作り直すコスト (1 件ぶんの呼び出し) しかかからない。
 */
const SIMPLIFIED_ONLY =
  /[这们个时说对关实现应该从问题认识软网级经样单变书专业务击开间为讲够继续获难产权义图习决张团队军岁]/;

export function hasSimplifiedOnlyChars(text: string | null): boolean {
  return text !== null && SIMPLIFIED_ONLY.test(text);
}

function collectBatchEntries(value: object): [number, unknown][] {
  if (Array.isArray(value)) {
    // ID が無い配列は並び順を信じるしかない。プロンプトでは 1 始まりの
    // 通し番号を振っているので、位置 + 1 に落とす。
    return value.map((item, i) => [readItemId(item) ?? i + 1, item]);
  }
  const values = Object.values(value);
  const nested = values.find((v): v is unknown[] => Array.isArray(v));
  if (nested) {
    return collectBatchEntries(nested);
  }
  return Object.entries(value)
    .filter(
      ([key, item]) => /^\d+$/.test(key) && item && typeof item === "object",
    )
    .map(([key, item]) => [Number(key), item]);
}

function readItemId(item: unknown): number | null {
  if (!item || typeof item !== "object" || !("id" in item)) {
    return null;
  }
  const id = (item as { id: unknown }).id;
  if (typeof id === "number" && Number.isInteger(id)) {
    return id;
  }
  // 文字列の "1" で返すモデルがある。
  if (typeof id === "string" && /^\d+$/.test(id.trim())) {
    return Number(id.trim());
  }
  return null;
}

export interface DigestClient {
  /** 生成に使ったモデルの識別子。再生成の判定に使うので候補行に残す。 */
  readonly modelId: string;
  complete(system: string, user: string): Promise<string>;
  /**
   * 複数件を 1 回で作らせる。**対応するプロバイダでだけ生えている。**
   * ローカル (Ollama) に無いのは `num_ctx` が 2048 しか無いため — 本文
   * 1000 字を数件並べただけで溢れ、後ろの記事が丸ごと切れる。
   */
  completeBatch?(system: string, user: string): Promise<string>;
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
    completeBatch: async (system, user) => {
      const response = await inference.inferFromText(`${system}\n\n${user}`, {
        schema: batchDigestSchema,
      });
      return response.response;
    },
  };
}
