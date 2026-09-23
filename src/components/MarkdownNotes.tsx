import { useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="markdown-content">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { trust: false, strict: false }]]}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : '[Image]'}</span>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

export function MarkdownNotes({
  value,
  onChange,
  label = 'Personal notes',
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const [mode, setMode] = useState<'write' | 'preview'>(value ? 'preview' : 'write');
  const input = useRef<HTMLTextAreaElement>(null);
  function insert(before: string, after = '', fallback = 'text') {
    const field = input.current;
    const start = field?.selectionStart ?? value.length;
    const end = field?.selectionEnd ?? start;
    const selected = value.slice(start, end) || fallback;
    onChange(value.slice(0, start) + before + selected + after + value.slice(end));
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(
        start + before.length,
        start + before.length + selected.length,
      );
    });
  }
  return (
    <section className="markdown-editor" aria-label={label}>
      <div className="notes-heading">
        <strong>{label}</strong>
        <div role="group" aria-label="Notes mode">
          <button
            type="button"
            aria-pressed={mode === 'write'}
            onClick={() => setMode('write')}
          >
            Write
          </button>
          <button
            type="button"
            aria-pressed={mode === 'preview'}
            onClick={() => setMode('preview')}
          >
            Preview
          </button>
        </div>
      </div>
      {mode === 'write' ? (
        <>
          <div className="notes-toolbar" aria-label="Markdown formatting">
            <button type="button" title="Bold" onClick={() => insert('**', '**')}>
              B
            </button>
            <button type="button" title="Italic" onClick={() => insert('*', '*')}>
              I
            </button>
            <button
              type="button"
              title="Heading"
              onClick={() => insert('\n## ', '\n', 'Heading')}
            >
              H2
            </button>
            <button
              type="button"
              title="Bullet list"
              onClick={() => insert('\n- ', '', 'Item')}
            >
              List
            </button>
            <button
              type="button"
              title="Link"
              onClick={() => insert('[', '](https://)', 'Link text')}
            >
              Link
            </button>
            <button
              type="button"
              title="Equation"
              onClick={() => insert('\n$$\n', '\n$$\n', 'E = mc^2')}
            >
              ∑
            </button>
            <button type="button" title="Code" onClick={() => insert('`', '`', 'code')}>
              Code
            </button>
          </div>
          <textarea
            ref={input}
            aria-label={label}
            rows={10}
            value={value}
            maxLength={100000}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Your ideas, observations, and questions…"
          />
          <small>Markdown supported · Inline math: $x^2$ · Display math: $$…$$</small>
        </>
      ) : (
        <div className="notes-preview">
          {value.trim() ? (
            <MarkdownView text={value} />
          ) : (
            <p>No notes yet. Choose Write to start.</p>
          )}
        </div>
      )}
    </section>
  );
}
