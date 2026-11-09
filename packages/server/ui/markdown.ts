/**
 * Markdown for message text, rendered straight to DOM nodes (never innerHTML), so message text cannot inject
 * markup. Covers what agents write: fenced code, headings, lists (nested by indent), blockquotes, GFM tables,
 * rules, paragraphs with line breaks kept, and inline code, bold, italic, strikethrough, links and bare URLs.
 * `plain` renders text outside markup (the website uses it to highlight @mentions).
 */

export type PlainRenderer = (text: string) => Node[];

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*\S*\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const INLINE_RE = new RegExp(
  [
    /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.source, // 1,2 code
    /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/.source, // 3,4 link
    /(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/.source, // 5 bare URL
    /\*\*(?=\S)([\s\S]*?\S)\*\*/.source, // 6 bold
    /__(?=\S)([\s\S]*?\S)__(?!\w)/.source, // 7 bold
    /~~(?=\S)([\s\S]*?\S)~~/.source, // 8 strike
    /(?<![\w*])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?![\w*])/.source, // 9 italic
    /(?<![\w_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w_])/.source, // 10 italic
  ].join("|"),
  "g"
);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, children: Node[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}

function inline(text: string, plain: PlainRenderer): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(...plain(text.slice(last, start)));
    last = start + m[0].length;
    if (m[2] !== undefined) {
      // Agents often wrap a bare URL or a message reference (#n) in backticks; keep the code look but make it clickable.
      const inner = /^#\d+$/.test(m[2].trim()) ? plain(m[2].trim()) : [document.createTextNode(m[2])];
      const code = el("code", "md-code", inner);
      out.push(/^https?:\/\/\S+$/.test(m[2].trim()) ? link(m[2].trim(), [code]) : code);
    } else if (m[4] !== undefined) {
      out.push(link(m[4], inline(m[3] ?? "", plain)));
    } else if (m[5] !== undefined) {
      out.push(link(m[5], [document.createTextNode(m[5])]));
    } else if (m[6] !== undefined || m[7] !== undefined) {
      out.push(el("strong", "", inline(m[6] ?? m[7] ?? "", plain)));
    } else if (m[8] !== undefined) {
      out.push(el("del", "", inline(m[8], plain)));
    } else {
      out.push(el("em", "", inline(m[9] ?? m[10] ?? "", plain)));
    }
  }
  if (last < text.length) out.push(...plain(text.slice(last)));
  return out;
}

function link(href: string, children: Node[]): HTMLAnchorElement {
  const a = el("a", "md-link", children);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

/** Lines joined with <br>, each rendered inline. */
function lines(text: string[], plain: PlainRenderer): Node[] {
  const out: Node[] = [];
  text.forEach((line, i) => {
    if (i > 0) out.push(document.createElement("br"));
    out.push(...inline(line.trimEnd(), plain));
  });
  return out;
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    RULE_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEP_RE.test(next))
  );
}

const indentOf = (line: string): number => (/^\s*/.exec(line)?.[0] ?? "").replace(/\t/g, "    ").length;

function blocks(src: string[], plain: PlainRenderer): Node[] {
  const out: Node[] = [];
  let i = 0;
  while (i < src.length) {
    const line = src[i] ?? "";
    const next = src[i + 1];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      i++;
      while (i < src.length && !(src[i] ?? "").trim().startsWith(marker)) body.push(src[i++] ?? "");
      i++; // closing fence (or end of text)
      out.push(el("pre", "md-pre", [el("code", "", [document.createTextNode(body.join("\n"))])]));
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      out.push(el("div", `md-h md-h${heading[1]?.length ?? 1}`, inline(heading[2] ?? "", plain)));
      i++;
      continue;
    }

    if (RULE_RE.test(line)) {
      out.push(el("hr", "md-hr"));
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < src.length && QUOTE_RE.test(src[i] ?? "")) body.push((src[i++] ?? "").replace(QUOTE_RE, ""));
      out.push(el("blockquote", "md-quote", blocks(body, plain)));
      continue;
    }

    if (line.includes("|") && next !== undefined && TABLE_SEP_RE.test(next)) {
      const header = splitRow(line);
      const aligns = splitRow(next).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : ""));
      i += 2;
      const rows: string[][] = [];
      while (i < src.length && (src[i] ?? "").includes("|") && (src[i] ?? "").trim() !== "") rows.push(splitRow(src[i++] ?? ""));
      const cell = (tag: "th" | "td", text: string, col: number): HTMLTableCellElement => {
        const c = el(tag, "", inline(text, plain));
        const align = aligns[col];
        if (align) c.style.textAlign = align;
        return c;
      };
      const thead = el("thead", "", [el("tr", "", header.map((t, c) => cell("th", t, c)))]);
      const tbody = el("tbody", "", rows.map((r) => el("tr", "", header.map((_, c) => cell("td", r[c] ?? "", c)))));
      out.push(el("div", "md-table-wrap", [el("table", "md-table", [thead, tbody])]));
      continue;
    }

    const item = LIST_RE.exec(line);
    if (item) {
      const base = indentOf(line);
      const ordered = /\d/.test(item[2] ?? "");
      const list = ordered ? el("ol", "md-list") : el("ul", "md-list");
      if (ordered) {
        const first = Number.parseInt(item[2] ?? "1", 10);
        if (first !== 1) list.setAttribute("start", String(first));
      }
      while (i < src.length) {
        const cur = LIST_RE.exec(src[i] ?? "");
        if (!cur || indentOf(src[i] ?? "") !== base || /\d/.test(cur[2] ?? "") !== ordered) break;
        const body = [cur[3] ?? ""];
        i++;
        // Continuation: deeper-indented lines, or plain lines directly under the item (lazy continuation).
        while (i < src.length) {
          const l = src[i] ?? "";
          if (l.trim() === "") {
            const after = src[i + 1];
            if (after !== undefined && after.trim() !== "" && indentOf(after) > base) {
              body.push("");
              i++;
              continue;
            }
            break;
          }
          if (indentOf(l) > base) {
            body.push(l.slice(Math.min(indentOf(l), base + 2)));
          } else if (!startsBlock(l, src[i + 1])) {
            body.push(l);
          } else {
            break;
          }
          i++;
        }
        const li = el("li", "");
        const inner = blocks(body, plain);
        // A single paragraph renders inline, so tight lists stay tight.
        const only = inner[0];
        if (inner.length === 1 && only instanceof HTMLElement && only.classList.contains("md-p")) {
          li.append(...Array.from(only.childNodes));
        } else {
          li.append(...inner);
        }
        list.append(li);
      }
      out.push(list);
      continue;
    }

    const para: string[] = [line];
    i++;
    while (i < src.length && (src[i] ?? "").trim() !== "" && !startsBlock(src[i] ?? "", src[i + 1])) para.push(src[i++] ?? "");
    out.push(el("div", "md-p", lines(para, plain)));
  }
  return out;
}

export function renderMarkdown(text: string, plain: PlainRenderer): Node[] {
  return blocks(text.replace(/\r\n?/g, "\n").split("\n"), plain);
}
