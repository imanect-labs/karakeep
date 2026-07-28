// Output checks for a single translated chunk.
//
// Kept free of db/config imports so the rules can be unit-tested directly.
// They exist because the inference endpoint is unreliable per call rather than
// per prompt: measured against DeepSeek V4 Flash, every prompt variant we tried
// echoed the source verbatim, prepended a preamble, or rewrote code on some
// chunks. Resampling clears it, so the caller checks and retries.

/** Strip a ```html ... ``` code fence the model may add despite instructions. */
export function stripCodeFence(s: string): string {
  const t = s.trim();
  const m = /^```(?:html)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1] : t;
}

/** Fresh instance every call: a shared /g regex carries lastIndex between uses. */
const codeishTags = () => /<(script|style|code|pre|kbd)[^>]*>[\s\S]*?<\/\1>/gi;

/** Visible prose of an HTML fragment, excluding code-ish elements. */
export function proseText(html: string): string {
  return html
    .replace(codeishTags(), " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tagSequence(html: string): string[] {
  return html.match(/<[^>]+>/g) ?? [];
}

/** Share of CJK characters among non-space characters. */
export function cjkRatio(text: string): number {
  const jp = text.match(/[぀-ヿ一-鿿]/g)?.length ?? 0;
  const nonSpace = text.match(/\S/g)?.length ?? 0;
  return nonSpace > 0 ? jp / nonSpace : 0;
}

/**
 * Drop a preamble the model sometimes writes before the fragment ("以下が…翻訳
 * したものです。", "# 翻訳結果", "Here is the translation…"). Only applied when the
 * source itself starts with a tag, so a fragment that legitimately begins with a
 * text node is left alone.
 */
export function stripPreamble(source: string, out: string): string {
  if (!source.trimStart().startsWith("<")) {
    return out;
  }
  const trimmed = out.trimStart();
  if (trimmed.startsWith("<")) {
    return out;
  }
  const firstTag = trimmed.indexOf("<");
  return firstTag === -1 ? out : trimmed.slice(firstTag);
}

/**
 * Put the source's <code>/<pre>/… blocks back into the output.
 *
 * The model translates string literals inside code ("found" -> "見つかりました",
 * True -> 真) and, measured on real chunks, it does so on *every* resample of the
 * same chunk — it is systematic, not random, so retrying only burns tokens. The
 * blocks have to survive byte-for-byte anyway, so splicing the originals back in
 * positionally is both free and exactly right. Skipped when the counts disagree,
 * since then the positions can't be trusted and it stays a reported problem.
 */
export function restoreCodeContent(source: string, out: string): string {
  const srcBlocks = source.match(codeishTags()) ?? [];
  const outBlocks = out.match(codeishTags()) ?? [];
  if (srcBlocks.length === 0 || srcBlocks.length !== outBlocks.length) {
    return out;
  }
  let i = 0;
  return out.replace(codeishTags(), () => srcBlocks[i++]);
}

/**
 * Problems worth spending another call on. Measured against the real endpoint
 * (DeepSeek V4 Flash): it echoes the input verbatim or mangles the markup on
 * some chunks, and resampling clears those, so the output is checked rather
 * than trusted. Code damage is repaired instead (see restoreCodeContent).
 */
export function findChunkProblems(
  source: string,
  out: string,
  targetIsJapanese: boolean,
): string[] {
  const problems: string[] = [];
  const srcProse = proseText(source);
  const outProse = proseText(out);

  // The model returned the fragment untranslated.
  if (srcProse.length > 100 && outProse === srcProse) {
    problems.push("echoed the source verbatim");
  } else if (
    targetIsJapanese &&
    srcProse.length > 200 &&
    cjkRatio(srcProse) < 0.1 &&
    cjkRatio(outProse) < 0.05
  ) {
    problems.push("output is still in the source language");
  }

  // Markup must survive verbatim; concatenated chunks have to rebuild the page.
  const srcTags = tagSequence(source);
  const outTags = tagSequence(out);
  if (Math.abs(srcTags.length - outTags.length) > 2) {
    problems.push(`tag count changed (${srcTags.length} -> ${outTags.length})`);
  }

  // Only reachable when restoreCodeContent could not repair it, i.e. the model
  // added or dropped a code block so the positions no longer line up.
  const srcCode = source.match(codeishTags())?.join("") ?? "";
  const outCode = out.match(codeishTags())?.join("") ?? "";
  if (srcCode && srcCode !== outCode) {
    problems.push("code content was modified");
  }

  return problems;
}
