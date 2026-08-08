// テキストノード方式の翻訳（imanect-labs fork）。
//
// 既存の外部プロバイダ経路は HTML チャンクをそのまま LLM に渡し、「タグを
// 一字一句変えるな」と指示して結果を検証している（`validate.ts`）。外部の
// 大きいモデルはこれで通るが、**ローカルの 4B 級はどれも通らない**。実測:
//
//   - translategemma:4b   … 散文は PASS、コードを含む章で 91 タグ → 16 タグに崩壊
//   - qwen3.5:4b          … 2 チャンク中 1 つで原文をそのままエコー
//   - CAT-Translate-3.3b  … HTML を渡すと「翻訳」ではなく**命令を実行**する
//     （`<code>rustup</code>` を含む段落を渡したら
//      `<code>rustup install 1.90.0</code>` が返ってきた）
//
// そこで LLM には素テキストしか見せない。タグはコード側で保存し、モデルには
// `[0]` のようなプレースホルダだけを見せる。構造の保存が「モデルへのお願い」
// から**コードの不変条件**になるので、`findChunkProblems` のタグ数チェックは
// 常に通る（実測: 102 タグ → 102 タグ、順序も完全一致）。
//
// 出力が元 HTML とバイトオフセット互換である必要はそのまま残る
// （ReaderView の `partialWithRemainder()` が
// `translatedContent + htmlContent.slice(translationSourceOffset)` を連結する）。
// この方式はタグを一切動かさないので、その要件を自動的に満たす。
//
// **既知の限界（実測、Rust 1.90 リリースノート 2 チャンク / CAT-Translate）**
//
//   構造:   102 → 102 タグ、108 → 108 タグ。順序も完全一致。問題 0 件
//   訳出:   段落 13 個中 8 個。残り 5 個は原文のまま残る
//             - 3 個 … 文中リンクが 3 つ以上あり、プレースホルダを戻せなかった
//                     （日本語の語順で移動し、対の片方だけ返ってくる）
//             - 2 個 … モデルの出力を検証で弾いた
//                     （`LLD 1.25` という存在しない版番号の捏造、`. . . .` への発散）
//
// つまり **「訳せた箇所は正しい / 訳せない箇所は原文が残る」** に倒してある。
// 訳し漏れが英語で残るのは読みにくいが、捏造された日本語が混ざるより害が
// 少ない。全文をきれいに訳したいなら TRANSLATION_PROVIDER=external のまま
// 大きいモデルを使うこと。

/**
 * 中身ごと触ってはいけない要素。`validate.ts` の codeishTags と揃える。
 * これらはブロックの区切りとして扱い、内側には一切立ち入らない。
 */
const OPAQUE_BLOCK_ELEMENTS = new Set(["script", "style", "pre", "textarea"]);

/**
 * 文中に現れるコード。要素まるごと 1 つのプレースホルダにする。
 *
 * 中身をモデルに見せると翻訳される（`found` → `見つかりました`、`True` → `真`）。
 * 実測ではこれが**再サンプリングしても毎回起きる**ので、そもそも見せない。
 */
const INLINE_OPAQUE_ELEMENTS = new Set(["code", "kbd", "samp", "var"]);

/**
 * ここで文が切れる要素。開始タグ・終了タグのどちらもセグメントの境界になる。
 * ここに無いタグ（a, em, strong, span, img …）は文中のものとして
 * プレースホルダで保存する。
 */
const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "col",
  "colgroup",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "nav",
  "noscript",
  "ol",
  "option",
  "p",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** 文中タグを隠すマーカー。本文に現れていたらこの方式は使わない。 */
const PLACEHOLDER = (n: number) => `[${n}]`;
/** Fresh instance every call: a shared /g regex carries lastIndex between uses. */
const placeholders = () => /\[\d+\]/g;

export interface InlineSegment {
  /** 元 HTML 内の位置。訳文を差し戻すときに使う。 */
  start: number;
  end: number;
  /** 文中タグとテキストだけを含む生の HTML。 */
  raw: string;
}

interface TagInfo {
  start: number;
  end: number;
  name: string;
  isClose: boolean;
}

function readTag(html: string, lt: number): TagInfo | null {
  const gt = html.indexOf(">", lt);
  if (gt === -1) {
    return null;
  }
  const raw = html.slice(lt, gt + 1);
  const name = /^<\/?\s*([a-zA-Z0-9-]+)/.exec(raw)?.[1]?.toLowerCase() ?? "";
  return { start: lt, end: gt + 1, name, isClose: raw[1] === "/" };
}

function findCloseTag(html: string, from: number, name: string): number {
  const re = new RegExp(`</\\s*${name}\\s*>`, "i");
  const match = re.exec(html.slice(from));
  return match ? from + match.index + match[0].length : html.length;
}

/**
 * 訳す単位に切る。1 セグメント = ブロック要素の内側にある「文中タグ + テキスト」。
 *
 * 文をブロック単位でまとめるのが肝心。テキストノード 1 つずつ訳すと、
 * `<a>` や `<code>` で切れた断片が単独でモデルに渡り、実測で「1987年」のような
 * 完全な捏造が出た。文として渡せばその失敗は起きない。
 */
export function extractInlineSegments(html: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let segStart = 0;
  let i = 0;

  const flush = (end: number) => {
    if (end <= segStart) {
      segStart = end;
      return;
    }
    const raw = html.slice(segStart, end);
    // 文字が 1 つも無い断片は訳す意味が無い。空白・記号だけを翻訳モデルに
    // 渡すと平気で文を捏造する。
    if (/\p{L}/u.test(raw.replace(/<[^>]+>/g, ""))) {
      segments.push({ start: segStart, end, raw });
    }
    segStart = end;
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      break;
    }

    if (html.startsWith("<!--", lt)) {
      flush(lt);
      const close = html.indexOf("-->", lt);
      i = close === -1 ? html.length : close + 3;
      segStart = i;
      continue;
    }

    const tag = readTag(html, lt);
    if (!tag) {
      // 閉じていないタグ。チャンクの切れ目でしか起きない。ここから先は
      // 触らない。
      break;
    }

    if (!tag.isClose && OPAQUE_BLOCK_ELEMENTS.has(tag.name)) {
      flush(lt);
      i = findCloseTag(html, tag.end, tag.name);
      segStart = i;
      continue;
    }

    if (BLOCK_ELEMENTS.has(tag.name) || OPAQUE_BLOCK_ELEMENTS.has(tag.name)) {
      flush(lt);
      i = tag.end;
      segStart = i;
      continue;
    }

    // 文中タグ。セグメントの一部として残す。
    i = tag.end;
  }

  flush(html.length);
  return segments;
}

export interface MaskedSegment {
  /** モデルに渡す文。文中タグは `[n]` に置き換わっている。 */
  masked: string;
  /** `[n]` に対応する元の文字列（タグ、またはコード要素まるごと）。 */
  tokens: string[];
  /** 元のセグメントの前後の空白。訳文にそのまま付け直す。 */
  leading: string;
  trailing: string;
}

/**
 * 文中タグを `[n]` に隠す。安全に使えないときは null（呼び出し側は
 * この方式をやめて 1 テキストノードずつ訳す経路に落ちる）。
 */
export function maskInlineTags(raw: string): MaskedSegment | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  // 本文にすでに `[0]` のような並びがあると、復元時にどれがタグだったか
  // 区別できない。数の一致だけ見て戻すと**別の位置にタグが入る**ので、
  // 疑わしいときは方式ごと使わない。
  if (placeholders().test(trimmed.replace(/<[^>]+>/g, ""))) {
    return null;
  }

  const leadingLength = raw.length - raw.trimStart().length;
  const tokens: string[] = [];
  let masked = "";
  let i = 0;

  while (i < trimmed.length) {
    const lt = trimmed.indexOf("<", i);
    if (lt === -1) {
      masked += trimmed.slice(i);
      break;
    }
    masked += trimmed.slice(i, lt);

    const tag = readTag(trimmed, lt);
    if (!tag) {
      masked += trimmed.slice(lt);
      break;
    }

    if (!tag.isClose && INLINE_OPAQUE_ELEMENTS.has(tag.name)) {
      // 要素まるごと 1 つのトークンにする。中身は絶対に見せない。
      const end = findCloseTag(trimmed, tag.end, tag.name);
      tokens.push(trimmed.slice(lt, end));
      masked += PLACEHOLDER(tokens.length - 1);
      i = end;
      continue;
    }

    tokens.push(trimmed.slice(lt, tag.end));
    masked += PLACEHOLDER(tokens.length - 1);
    i = tag.end;
  }

  // 隠した後に文字が 1 つも残らないセグメント（`<a><code>f32::floor</code></a>`
  // だけのリスト項目など）は訳す対象が無い。`[0][1][2]` だけをモデルに渡すと
  // **記号について解説を始める** — 実測で「1つのテキストとして翻訳して
  // ください。」がリスト 19 項目すべてに挿入された。
  if (!/\p{L}/u.test(masked.replace(placeholders(), ""))) {
    return null;
  }

  return {
    masked,
    tokens,
    leading: raw.slice(0, leadingLength),
    trailing: raw.slice(leadingLength + trimmed.length),
  };
}

/** タグ列が開閉の対応した入れ子になっているか。 */
export function isWellNested(html: string): boolean {
  const stack: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      break;
    }
    const tag = readTag(html, lt);
    if (!tag) {
      return false;
    }
    const raw = html.slice(tag.start, tag.end);
    if (tag.isClose) {
      if (stack.pop() !== tag.name) {
        return false;
      }
    } else if (!raw.endsWith("/>") && !VOID_ELEMENTS.has(tag.name)) {
      stack.push(tag.name);
    }
    i = tag.end;
  }
  return stack.length === 0;
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * 訳文の `[n]` を元のタグに戻す。戻せないときは null。
 *
 * **並び順は問わないが、全部がちょうど 1 回ずつ出ていることと、戻した結果が
 * 入れ子として成立していることを要求する。**
 *
 * 順序まで一致を求めると取りこぼしが多すぎた（実測: 段落 13 個中 3 個が
 * 英語のまま残った）。日本語は英語と語順が違うので、`<a>` で囲まれた句が
 * 文中で移動するのは正しい翻訳の結果であって失敗ではない。一方、開きタグと
 * 閉じタグが入れ替わると入れ子が壊れるので、そこは実際に検査して弾く。
 */
/**
 * 日本語に訳すと、モデルは括弧を全角に直してくる（実測: `[0]` → `【0】`）。
 * 訳としては自然な振る舞いなので、責めずにこちらで戻す。
 */
export function normalizePlaceholders(text: string): string {
  return text.replace(/[［【〔]\s*(\d+)\s*[］】〕]/g, "[$1]");
}

export function restoreInlineTags(
  raw: string,
  tokens: string[],
): string | null {
  const translated = normalizePlaceholders(raw);
  const found = translated.match(placeholders()) ?? [];
  if (found.length !== tokens.length) {
    return null;
  }
  const seen = new Set(found);
  if (seen.size !== tokens.length) {
    return null;
  }
  for (let n = 0; n < tokens.length; n++) {
    if (!seen.has(PLACEHOLDER(n))) {
      return null;
    }
  }
  const restored = translated.replace(placeholders(), (m) => {
    const index = Number(m.slice(1, -1));
    return tokens[index];
  });
  return isWellNested(restored) ? restored : null;
}

export interface TextRun {
  /** セグメント内の位置。 */
  start: number;
  end: number;
  /** 前後の空白を除いた本文。空白は元のものをそのまま戻す。 */
  text: string;
  leading: string;
  trailing: string;
}

/**
 * セグメントの中のテキストノードを 1 つずつ拾う（プレースホルダ方式が
 * 失敗したときの受け皿）。
 *
 * 文の途中で切れた断片が単独でモデルに渡るので訳質は落ちる。それでも
 * タグは 1 つも動かないので、**構造は必ず保たれる**。
 */
export function extractTextRuns(segment: string): TextRun[] {
  const runs: TextRun[] = [];
  let i = 0;

  const push = (start: number, end: number) => {
    const raw = segment.slice(start, end);
    const text = raw.trim();
    if (!text || !/\p{L}/u.test(text)) {
      return;
    }
    const leadingLength = raw.length - raw.trimStart().length;
    runs.push({
      start,
      end,
      text,
      leading: raw.slice(0, leadingLength),
      trailing: raw.slice(leadingLength + text.length),
    });
  };

  while (i < segment.length) {
    const lt = segment.indexOf("<", i);
    if (lt === -1) {
      push(i, segment.length);
      break;
    }
    if (lt > i) {
      push(i, lt);
    }
    const tag = readTag(segment, lt);
    if (!tag) {
      break;
    }
    if (!tag.isClose && INLINE_OPAQUE_ELEMENTS.has(tag.name)) {
      // コードの中身は絶対に訳さない。
      i = findCloseTag(segment, tag.end, tag.name);
      continue;
    }
    i = tag.end;
  }

  return runs;
}

/** テキストノード単位の訳文を差し戻す。 */
export function applyTextRuns(
  segment: string,
  runs: TextRun[],
  translations: (string | null)[],
): string {
  const out: string[] = [];
  let cursor = 0;
  runs.forEach((run, index) => {
    out.push(segment.slice(cursor, run.start));
    const translated = translations[index];
    out.push(
      translated === null || translated === undefined
        ? segment.slice(run.start, run.end)
        : run.leading + translated + run.trailing,
    );
    cursor = run.end;
  });
  out.push(segment.slice(cursor));
  return out.join("");
}

/** 訳文を差し戻す。null のセグメントは原文のまま残る。 */
export function applySegments(
  html: string,
  segments: InlineSegment[],
  replacements: (string | null)[],
): string {
  const out: string[] = [];
  let cursor = 0;
  segments.forEach((segment, index) => {
    out.push(html.slice(cursor, segment.start));
    const replacement = replacements[index];
    out.push(replacement ?? segment.raw);
    cursor = segment.end;
  });
  out.push(html.slice(cursor));
  return out.join("");
}

const ENTITIES: [RegExp, string][] = [
  [/&nbsp;/gi, " "],
  [/&quot;/gi, '"'],
  [/&#0*39;/g, "'"],
  [/&apos;/gi, "'"],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  // `&amp;` は最後。先に戻すと `&amp;lt;` が `<` になってしまう。
  [/&amp;/gi, "&"],
];

/** 実体参照を素の文字に戻してからモデルへ渡す。 */
export function decodeEntities(text: string): string {
  return ENTITIES.reduce((acc, [re, ch]) => acc.replace(re, ch), text);
}

/**
 * モデルの出力を HTML のテキストノードとして安全な形に戻す。
 *
 * `&` と `<` を逃がさないと、訳文に出た記号がタグや実体参照として解釈され、
 * 「タグ数は合っているのに構造が壊れる」という一番見つけにくい壊れ方をする。
 */
export function encodeEntities(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
