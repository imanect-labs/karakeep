import type { ZTagStyle } from "./types/users";
import {
  getCuratedTagsPrompt,
  getTagStylePrompt,
  getPotentialRelevantTagsPrompt,
} from "./utils/tag";

/**
 * Remove duplicate whitespaces to avoid tokenization issues
 */
function preprocessContent(content: string) {
  return content.replace(/(\s){10,}/g, "$1");
}

export function buildImagePrompt(
  lang: string,
  customPrompts: string[],
  tagStyle: ZTagStyle,
  curatedTags?: string[],
  potentialRelevantTags?: string[],
) {
  const tagStyleInstruction = getTagStylePrompt(tagStyle);
  const curatedInstruction = getCuratedTagsPrompt(curatedTags);
  const potentialRelevantTagsInstruction = getPotentialRelevantTagsPrompt(
    potentialRelevantTags,
  );

  return `
You are an expert whose responsibility is to help with automatic tagging for a read-it-later/bookmarking app.
Analyze the attached image and suggest relevant tags that describe its key themes, topics, and main ideas. The rules are:
- Prefer concrete, durable tags: named products, technologies, projects, standards, subject areas, and important concepts.
- Include only retrieval-worthy tags that describe the saved item's intended content, not incidental UI or page chrome.
- The tags must be in ${lang}.
- Keep each tag short: ideally 1-3 words. Do not include parenthetical explanations, comma-separated examples, or long descriptive phrases inside a tag.
- Prefer durable subject tags over one-off facts, examples, source organizations, page sections, or implementation details unless they are central to the whole item.
- Do NOT generate any tags if the image is mainly:
    - A screenshot of an error, unavailable, forbidden, unauthorized, not found, DNS, timeout, or service failure page
    - A Cloudflare/security check, CAPTCHA, bot check, anti-DDoS challenge, browser verification, or access-blocked page
    - Boilerplate content such as cookie consent, login walls, GDPR notices, navigation menus, or a blank/empty image
  In these cases, return an empty tags array. Do not tag the failure/interstitial page itself.
- Aim for 10-15 tags.
- If there are no good tags, leave the array empty.
${curatedInstruction}
${potentialRelevantTagsInstruction}
${tagStyleInstruction}
${customPrompts && customPrompts.map((p) => `- ${p}`).join("\n")}
You must respond in valid JSON with the key "tags" and the value is list of tags. Don't wrap the response in a markdown code.`;
}

/**
 * Construct tagging prompt for text content
 */
export function constructTextTaggingPrompt(
  lang: string,
  customPrompts: string[],
  content: string,
  tagStyle: ZTagStyle,
  curatedTags?: string[],
  potentialRelevantTags?: string[],
): string {
  const tagStyleInstruction = getTagStylePrompt(tagStyle);
  const curatedInstruction = getCuratedTagsPrompt(curatedTags);
  const potentialRelevantTagsInstruction = getPotentialRelevantTagsPrompt(
    potentialRelevantTags,
  );

  return `
You are an expert whose responsibility is to help with automatic tagging for a read-it-later/bookmarking app.
Analyze the TEXT_CONTENT below and suggest relevant tags that describe its key themes, topics, and main ideas. The rules are:
- Prefer concrete, durable tags: named products, technologies, projects, standards, subject areas, and important concepts.
- Include only retrieval-worthy tags that describe the saved item's intended content, not incidental page chrome.
- The tags must be in ${lang}.
- Keep each tag short: ideally 1-3 words. Do not include parenthetical explanations, comma-separated examples, or long descriptive phrases inside a tag.
- Prefer durable subject tags over one-off facts, examples, source organizations, page sections, or implementation details unless they are central to the whole item.
- Do NOT generate any tags if the content is mainly:
    - An error, unavailable, forbidden, unauthorized, not found, DNS, timeout, or service failure page
    - A Cloudflare/security check, CAPTCHA, bot check, anti-DDoS challenge, browser verification, or access-blocked page
    - Boilerplate content such as cookie consent, login walls, GDPR notices, navigation menus, or empty pages
  In these cases, return an empty tags array. Do not tag the failure/interstitial page itself.
- Aim for 3-5 tags.
- If there are no good tags, leave the array empty.
${curatedInstruction}
${potentialRelevantTagsInstruction}
${tagStyleInstruction}
${customPrompts && customPrompts.map((p) => `- ${p}`).join("\n")}

<TEXT_CONTENT>
${content}
</TEXT_CONTENT>
You must respond in JSON with the key "tags" and the value is an array of string tags.`;
}

/**
 * Construct a structure-preserving HTML translation prompt (imanect-labs fork).
 * The chunk may be a partial HTML fragment; tags must be preserved verbatim so
 * that concatenating the translated chunks reproduces the original structure.
 */
export interface TranslationContext {
  /** Title of the document the fragment belongs to. */
  title?: string | null;
  /** Plain-text tail of the source that precedes this fragment. */
  previousSource?: string | null;
  /** Plain-text tail of the translation produced for that preceding source. */
  previousTranslation?: string | null;
  /** e.g. "です・ます調". Empty disables the style instruction. */
  style?: string | null;
}

export function constructTranslationPrompt(
  targetLang: string,
  htmlChunk: string,
  context: TranslationContext = {},
): string {
  // "japanese" -> "Japanese"; the env value is lowercase but reads as a typo in
  // the prompt.
  const lang = targetLang.charAt(0).toUpperCase() + targetLang.slice(1);
  const styleRule = context.style
    ? `\n- Use a consistent ${context.style} style across the whole document.`
    : "";

  const contextLines = [
    context.title ? `Document title: ${context.title}` : null,
    context.previousSource
      ? `Source text immediately before this fragment:\n"""\n…${context.previousSource}\n"""`
      : null,
    context.previousTranslation
      ? `Your translation of that preceding text:\n"""\n…${context.previousTranslation}\n"""`
      : null,
  ].filter(Boolean);

  const contextBlock = contextLines.length
    ? `\n# Context (reference ONLY)
This is background so that your terminology, style, and sentence flow continue naturally
from what came before. It is NOT part of the fragment to translate: do NOT translate it,
do NOT repeat it, and do NOT include any of it in your output.

${contextLines.join("\n\n")}
`
    : "";

  return `You are a professional translator producing publication-quality ${lang}.
Translate the visible text of the HTML fragment below into ${lang}.

# Fidelity (highest priority)
- Preserve the meaning exactly. Never add, drop, summarize, explain, or embellish anything.
- Keep every fact, number, unit, date, name, and code identifier exactly as in the original.
- Keep negations, conditions, and modality (must / should / may / might) exactly as strong or
  as tentative as the original. Do not turn a hedge into an assertion or vice versa.
- If the original is ambiguous or vague, keep it ambiguous. Do not resolve it for the reader.
- Preserve the author's tone (humour, irony, informality) instead of neutralising it.

# Naturalness
- Translate meaning, not words. Reorder clauses, split or merge sentences, and change parts of
  speech as needed so the result reads as if it had been written in ${lang} originally.
- Drop English pronouns (you / we / it / they) and articles where ${lang} does not need
  them. Do not render them mechanically.
- Avoid translationese: chained "の", redundant "〜することができる" (prefer "〜できる"),
  mechanical "そして / しかし", and English word order left intact.
- Keep technical terms, product names, API names, and identifiers in their original form.
  Translate a term only when a well-established ${lang} equivalent exists, and use the
  same rendering for the same term throughout.${styleRule}

# HTML rules
- Preserve the HTML structure EXACTLY: do not add, remove, reorder, open, or close any tags or attributes.
- The fragment may be a partial piece of a larger document and may contain unbalanced or unclosed tags. Leave them exactly as they are.
- Translate ONLY human-readable text nodes. Do NOT translate tag names, attribute names or values, URLs, or the contents of <code>, <pre>, <kbd>, <script>, or <style> elements.
- Do NOT wrap the output in markdown code fences and do NOT add any explanation.
- Respond with ONLY the translated HTML fragment.
${contextBlock}
# HTML fragment to translate
${htmlChunk}`;
}

/**
 * Construct summary prompt
 */
export function constructSummaryPrompt(
  lang: string,
  customPrompts: string[],
  content: string,
): string {
  return `
Summarize the following content responding ONLY with the summary. You MUST follow the following rules:
- Summary must be in 3-4 sentences.
- The summary must be in ${lang}.
${customPrompts && customPrompts.map((p) => `- ${p}`).join("\n")}
    ${content}`;
}

/**
 * Build text tagging prompt without truncation (for previews/UI)
 */
export function buildTextPromptUntruncated(
  lang: string,
  customPrompts: string[],
  content: string,
  tagStyle: ZTagStyle,
  curatedTags?: string[],
): string {
  return constructTextTaggingPrompt(
    lang,
    customPrompts,
    preprocessContent(content),
    tagStyle,
    curatedTags,
  );
}

/**
 * Build summary prompt without truncation (for previews/UI)
 */
export function buildSummaryPromptUntruncated(
  lang: string,
  customPrompts: string[],
  content: string,
): string {
  return constructSummaryPrompt(
    lang,
    customPrompts,
    preprocessContent(content),
  );
}

/**
 * Build OCR prompt for extracting text from images using LLM
 */
export function buildOCRPrompt(): string {
  return `You are an OCR (Optical Character Recognition) expert. Your task is to extract ALL text from this image.

Rules:
- Extract every piece of text visible in the image, including titles, body text, captions, labels, watermarks, and any other textual content.
- Preserve the original structure and formatting as much as possible (e.g., paragraphs, lists, headings).
- If text appears in multiple columns, read from left to right, top to bottom.
- If text is partially obscured or unclear, make your best attempt and indicate uncertainty with [unclear] if needed.
- Do not add any commentary, explanations, or descriptions of non-text elements.
- If there is no text in the image, respond with an empty string.
- Output ONLY the extracted text, nothing else.`;
}
