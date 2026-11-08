import { JSDOM, VirtualConsole } from "jsdom";

/** Draft output is plain prose, never HTML and never resumable progress. */
export function streamingProse(html: string): string {
  const input = html.replace(/^\s*```(?:html)?\s*/i, "");
  const dom = new JSDOM(input, { virtualConsole: new VirtualConsole() });
  try {
    const doc = dom.window.document;
    doc
      .querySelectorAll("script,style,pre,code,kbd")
      .forEach((n) => n.remove());
    doc
      .querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,blockquote")
      .forEach((n) => n.append("\n\n"));
    return (doc.body.textContent ?? "").replace(/`{1,3}\s*$/, "").trim();
  } finally {
    dom.window.close();
  }
}
