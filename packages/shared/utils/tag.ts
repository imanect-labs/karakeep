import type { ZTagStyle } from "../types/users";

/**
 * Ensures exactly ONE leading #
 */
export function normalizeTagName(raw: string): string {
  return raw.trim().replace(/^#+/, ""); // strip every leading #
}

export type TagStyle = ZTagStyle;

export function getTagStylePrompt(style: TagStyle): string {
  switch (style) {
    case "lowercase-hyphens":
      return "- Use lowercase letters with hyphens between words (e.g., 'machine-learning', 'web-development')";
    case "lowercase-spaces":
      return "- Use lowercase letters with spaces between words (e.g., 'machine learning', 'web development')";
    case "lowercase-underscores":
      return "- Use lowercase letters with underscores between words (e.g., 'machine_learning', 'web_development')";
    case "titlecase-spaces":
      return "- Use title case with spaces between words (e.g., 'Machine Learning', 'Web Development')";
    case "titlecase-hyphens":
      return "- Use title case with hyphens between words (e.g., 'Machine-Learning', 'Web-Development')";
    case "camelCase":
      return "- Use camelCase format (e.g., 'machineLearning', 'webDevelopment')";
    case "as-generated":
    default:
      return "";
  }
}

export function getCuratedTagsPrompt(curatedTags?: string[]): string {
  if (curatedTags && curatedTags.length > 0) {
    return `- ONLY use tags from this predefined list: [${curatedTags.join(", ")}]. Do not create any new tags outside this list. If no tags fit, don't emit any.`;
  }
  return "";
}

/**
 * Tags the library already uses (imanect-labs fork).
 *
 * Upstream only offered these as a soft hint from similar bookmarks. Left that
 * way, each item invents its own wording and the library ends up holding "LLM",
 * "llm" and "大規模言語モデル" side by side, so the instruction is a requirement
 * and names the failure modes explicitly.
 */
export function getPotentialRelevantTagsPrompt(
  potentialRelevantTags?: string[],
): string {
  if (potentialRelevantTags && potentialRelevantTags.length > 0) {
    return `- The following tags already exist. If one of them fits the content, you MUST reuse it verbatim -- same spelling, same casing, same language. Never emit a variant of an existing tag: no case changes, no different separators, no singular/plural switch, and no translation of it into another language (if "LLM" is listed, do not emit "llm", "L.L.M." or its translated equivalent). Only invent a new tag when nothing listed fits: ${potentialRelevantTags.join(", ")}`;
  }
  return "";
}
