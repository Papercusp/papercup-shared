'use client';

export interface BrainstormPayload {
  content: string;
}

export interface BrainstormReadOnlyViewProps {
  data: BrainstormPayload;
}

// Tiny markdown-ish renderer: split on blank lines, recognize ## headers,
// render the rest as preserved-whitespace paragraphs. Avoids pulling in a
// markdown lib for a v1.
function renderBlocks(content: string) {
  if (!content || !content.trim()) return null;
  const blocks = content.replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks.map((b, i) => {
    const trimmed = b.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('### ')) {
      return <h4 key={i} className="pc-brainstorm-h4">{trimmed.slice(4)}</h4>;
    }
    if (trimmed.startsWith('## ')) {
      return <h3 key={i} className="pc-brainstorm-h3">{trimmed.slice(3)}</h3>;
    }
    if (trimmed.startsWith('# ')) {
      return <h2 key={i} className="pc-brainstorm-h2">{trimmed.slice(2)}</h2>;
    }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const items = trimmed.split('\n').map((line) => line.replace(/^[-*]\s+/, ''));
      return (
        <ul key={i} className="pc-brainstorm-ul">
          {items.map((it, j) => <li key={j}>{it}</li>)}
        </ul>
      );
    }
    return <p key={i} className="pc-brainstorm-p">{trimmed}</p>;
  });
}

export default function BrainstormReadOnlyView({ data }: BrainstormReadOnlyViewProps) {
  const content = data?.content ?? '';
  if (!content.trim()) {
    return (
      <div className="pc-brainstorm pc-brainstorm-empty">
        <p>No brainstorm content yet.</p>
        <em>The director hasn't written anything in the brainstorm canvas.</em>
      </div>
    );
  }
  return (
    <div className="pc-brainstorm">
      <div className="pc-brainstorm-doc">
        {renderBlocks(content)}
      </div>
    </div>
  );
}
