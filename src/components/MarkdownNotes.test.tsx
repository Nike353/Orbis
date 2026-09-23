import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { MarkdownNotes, MarkdownView } from './MarkdownNotes';

describe('Markdown research notes', () => {
  it('renders headings, lists, tables and LaTeX without executing HTML', () => {
    const { container } = render(
      <MarkdownView
        text={
          '## Insight\n\n- **Useful** idea\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n$$\nL = \\frac{x^2}{2}\n$$\n\n<script>alert(1)</script>\n[bad](javascript:alert(1))'
        }
      />,
    );
    expect(screen.getByRole('heading', { name: 'Insight' })).toBeTruthy();
    expect(container.querySelector('strong')?.textContent).toBe('Useful');
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelector('.katex')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).not.toContain('javascript:');
  });
  it('keeps edited Markdown when switching between write and preview', () => {
    function Editor() {
      const [value, setValue] = useState('');
      return <MarkdownNotes value={value} onChange={setValue} />;
    }
    render(<Editor />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Personal notes' }), {
      target: { value: '## New idea\n\n$x^2$' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByRole('heading', { name: 'New idea' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Write' }));
    expect(
      (screen.getByRole('textbox', { name: 'Personal notes' }) as HTMLTextAreaElement)
        .value,
    ).toContain('$x^2$');
  });
});
