import { HIT_END, HIT_START } from "../src/services/search";

/**
 * Renders a search snippet with matched words highlighted. The snippet is
 * plain text with marker characters — it is never treated as HTML, so text
 * inside documents can't inject anything into the page.
 */
export function Snippet({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest.length) {
    const start = rest.indexOf(HIT_START);
    if (start < 0) { parts.push(rest); break; }
    parts.push(rest.slice(0, start));
    const end = rest.indexOf(HIT_END, start + 1);
    const word = end < 0 ? rest.slice(start + 1) : rest.slice(start + 1, end);
    parts.push(<mark key={key++}>{word}</mark>);
    rest = end < 0 ? "" : rest.slice(end + 1);
  }
  return <span className="snippet">{parts}</span>;
}
