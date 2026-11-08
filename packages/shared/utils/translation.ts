const escapeText = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function readerTranslationHtml(input: {
  source: string;
  translated: string;
  sourceOffset: number | null;
  incomplete: boolean;
  preview?: { text: string; sourceEnd: number } | null;
}) {
  if (!input.incomplete) return input.translated;
  const offset = input.sourceOffset ?? 0;
  const preview = input.preview;
  if (
    preview?.text &&
    preview.sourceEnd > offset &&
    preview.sourceEnd <= input.source.length
  ) {
    // Provider HTML is never inserted into the page before validation. Only
    // escaped prose is shown while this source chunk is being translated.
    return (
      input.translated +
      `<p aria-busy="true" style="white-space:pre-wrap">${escapeText(preview.text)}</p>` +
      input.source.slice(preview.sourceEnd)
    );
  }
  return input.translated + input.source.slice(offset);
}
