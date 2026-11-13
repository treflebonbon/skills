import { readFileSync } from "node:fs";
import { QuoteType, Tokenizer } from "./vendor/html-tokenizer.js";

// Python の str.split() と同じ空白集合。BOM は空白に含めない。
const whitespace = /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

function parseHtml(source: string) {
  let tag = "";
  let attribute = "";
  let value = "";
  let classValue = "";
  let inside = false;
  let diagrams = 0;
  let consumed = 0;
  const parts: string[] = [];
  const errors: string[] = [];
  const markup = (kind: string) => {
    if (inside) errors.push(`Mermaid の <pre> 内に ${kind} があります`);
  };
  const startTag = (selfClosing: boolean, end: number) => {
    if (inside) markup(`<${tag}${selfClosing ? "/" : ""}> markup`);
    else if (tag === "pre" && classValue.split(whitespace).includes("mermaid")) {
      diagrams++;
      if (selfClosing) errors.push("Mermaid の <pre> が self-closing です");
      else inside = true;
    }
    consumed = end + 1;
  };
  const tokenizer = new Tokenizer(
    { decodeEntities: true, recognizeSelfClosing: true },
    {
      onopentagname(start, end) {
        tag = source.slice(start, end).toLowerCase();
        classValue = "";
      },
      onattribname(start, end) {
        attribute = source.slice(start, end).toLowerCase();
        value = "";
      },
      onattribdata(start, end) {
        value += source.slice(start, end);
      },
      onattribentity(codepoint) {
        value += String.fromCodePoint(codepoint);
      },
      onattribend(quote) {
        if (attribute === "class") classValue = quote === QuoteType.NoValue ? "" : value;
      },
      onopentagend(end) {
        startTag(false, end);
      },
      onselfclosingtag(end) {
        startTag(true, end);
      },
      onclosetag(start, end) {
        const name = source.slice(start, end).toLowerCase();
        if (inside) {
          if (name === "pre") inside = false;
          else markup(`</${name}> markup`);
        }
        consumed = source.indexOf(">", end) + 1;
      },
      ontext(start, end) {
        parts.push(source.slice(start, end));
        consumed = end;
      },
      ontextentity(codepoint, end) {
        parts.push(String.fromCodePoint(codepoint));
        consumed = end;
      },
      oncomment(start, end) {
        const kind =
          source.slice(start - 1, start + 1) === "<?"
            ? "processing instruction"
            : source.slice(start, start + 7) === "[CDATA["
              ? "HTML declaration"
              : "HTML comment";
        markup(kind);
        consumed = Math.min(end + 1, source.length);
      },
      ondeclaration(_start, end) {
        markup("HTML declaration");
        consumed = end + 1;
      },
      onprocessinginstruction(_start, end) {
        markup("processing instruction");
        consumed = end + 1;
      },
      oncdata(_start, end) {
        markup("HTML declaration");
        consumed = end + 1;
      },
      onend() {
        // Tokenizer が EOF で省略する doctype も既存の診断対象に含める。
        if (source.slice(consumed).toLowerCase().startsWith("<!doctype"))
          markup("HTML declaration");
      },
    },
  );
  tokenizer.write(source);
  tokenizer.end();
  if (inside) errors.push("Mermaid の <pre> が閉じていません");
  return { diagrams, errors, text: parts.join("").split(whitespace).filter(Boolean).join(" ") };
}

function decode(raw: Uint8Array, message: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new Error(message);
  }
}

export function artifactText(raw: Uint8Array): string {
  return parseHtml(decode(raw, "レポートは UTF-8 で読めません")).text;
}

function main(args: string[]) {
  if (args.length !== 1) throw new Error("使い方: check-architecture-report <report.html>");
  let source: string;
  try {
    source = decode(readFileSync(args[0]!), "HTML report を UTF-8 で読めません");
  } catch {
    throw new Error("HTML report を UTF-8 で読めません");
  }
  const result = parseHtml(source);
  if (result.errors.length) throw new Error(result.errors.join("; "));
  console.log(
    JSON.stringify({
      static_check: "passed",
      expected_mermaid_diagrams: result.diagrams,
      render_check: "not_performed",
    }),
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`エラー: ${(error as Error).message}`);
    process.exit(1);
  }
}
