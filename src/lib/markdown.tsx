import React from 'react';

/*
 * Tiny, dependency-free, XSS-safe Markdown renderer for chat messages. It emits
 * React nodes (never raw HTML), so text is always escaped by React and links are
 * limited to http(s)/mailto. Supports the subset that shows up in support chats:
 * bold, italic, inline code, strikethrough, links (Markdown + bare URLs),
 * bullet/numbered lists, and line breaks.
 */

// One pass over a line, tokenising inline styles. Order matters (code first so
// its contents aren't re-parsed).
const INLINE =
  /(`[^`]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^\s)]+\))|(\*[^*\n]+\*)|(_[^_\n]+_)|(https?:\/\/[^\s]+)/g;

function safeHref(url: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

function link(href: string, label: string, key: string): React.ReactNode {
  const h = safeHref(href);
  if (!h) return label;
  return (
    <a key={key} href={h} target="_blank" rel="noopener noreferrer" className="underline break-all">
      {label}
    </a>
  );
}

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (m[1]) {
      out.push(<code key={key} className="px-1 py-0.5 rounded bg-black/10 font-mono text-[0.85em]">{tok.slice(1, -1)}</code>);
    } else if (m[2]) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (m[3]) {
      out.push(<span key={key} className="line-through">{tok.slice(2, -2)}</span>);
    } else if (m[4]) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      out.push(mm ? link(mm[2], mm[1], key) : tok);
    } else if (m[5]) {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    } else if (m[6]) {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    } else if (m[7]) {
      out.push(link(tok, tok, key));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Render a Markdown string as safe React nodes. */
export function Markdown({ text }: { text: string }): React.ReactElement {
  const lines = (text ?? '').split('\n');
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    const key = `p-${blocks.length}`;
    blocks.push(
      <p key={key} className="whitespace-pre-wrap break-words">
        {para.flatMap((ln, i) => {
          const nodes = renderInline(ln, `${key}-${i}`);
          return i === 0 ? nodes : [<br key={`${key}-br-${i}`} />, ...nodes];
        })}
      </p>,
    );
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const key = `l-${blocks.length}`;
    const items = list.items.map((it, i) => <li key={`${key}-${i}`}>{renderInline(it, `${key}-${i}`)}</li>);
    blocks.push(
      list.ordered
        ? <ol key={key} className="list-decimal ml-5 space-y-0.5">{items}</ol>
        : <ul key={key} className="list-disc ml-5 space-y-0.5">{items}</ul>,
    );
    list = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; }
      list.items.push(ul[1]);
    } else if (ol) {
      flushPara();
      if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; }
      list.items.push(ol[1]);
    } else if (line.trim() === '') {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();

  return <div className="space-y-1.5">{blocks}</div>;
}
