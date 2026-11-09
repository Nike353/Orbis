import { useId, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  Cloud,
  Layers,
  Network,
  Plus,
  Sparkles,
  Table2,
  X,
} from 'lucide-react';
import '../styles/onboarding.css';

type Outcome = 'completed' | 'skipped';
type Step = {
  title: string;
  body: string;
  hint: string;
  target?: string;
  icon: typeof Network;
};
type Bounds = { left: number; top: number; width: number; height: number };

function steps(desktop: boolean): Step[] {
  return [
    {
      title: 'Welcome to your research universe.',
      body: 'One place to read, take notes, discuss with your own agent, and connect ideas. Let’s find your way around.',
      hint: 'A quick look around. No papers are added and no agent runs during this tour.',
      icon: Sparkles,
    },
    {
      title: 'Start with a source.',
      body: 'Add a research paper, blog post, or web page. Paste its URL, choose Codex or Claude Code, and select a model and effort. Your agent reads the source and connects it to your library.',
      hint: 'Install and sign in to an agent CLI first. Orbis uses your existing account and its limits.',
      target: '[aria-label="Add paper"]',
      icon: Plus,
    },
    {
      title: 'Read. Highlight. Make it yours.',
      body: 'Find a source in Library, select it, and choose Read. The original opens beside Summary, My notes, Discuss, and Connections. Highlight a passage or write your own Markdown notes and equations.',
      hint: 'Attach or retrieve the original. Your personal notes stay separate from generated summaries.',
      target: '[aria-label="Library"]',
      icon: BookOpen,
    },
    {
      title: 'Ask your own agent.',
      body: 'Use Discuss for questions across your library. For a single paper, use its Discuss tab beside the original—or select a passage and ask about it.',
      hint: 'Check Sources and context for the evidence used. Review proposed edits before accepting them.',
      target: '.app-nav [aria-label="Discuss"]',
      icon: Bot,
    },
    {
      title: 'See papers side by side.',
      body: 'Choose Compare, pick your papers, and choose criteria such as architecture, results, or limitations. Expand a cell’s evidence, ask follow-ups, or export the table.',
      hint: 'You can add your own comparison criteria. Missing evidence should stay visible, not become a guess.',
      target: '.app-nav [aria-label="Compare"]',
      icon: Table2,
    },
    {
      title: 'Follow the connections.',
      body: 'Drag to orbit the 3D universe and scroll to zoom. Select a paper to follow its connections. Focus or filter a cluster, hover over a connection for its notes, or switch to 2D Lineages.',
      hint: 'The universe grows with your library. Create your own clusters and connections, too.',
      target: '[aria-label="3D universe view"]',
      icon: Network,
    },
    {
      title: 'Your library. Your rules.',
      body: desktop
        ? 'Your library stays on this computer. Use the cloud button for optional encrypted Google Drive sync across laptops. The folder beside Orbis lets you keep independent graphs for different projects.'
        : 'Use the folder beside Orbis to keep independent graphs for different projects. Your library stays on your computer. The desktop app also offers optional encrypted Google Drive sync across laptops.',
      hint: 'Ready to begin? Add your first source. You can replay this tour anytime with the ? button in the toolbar.',
      target: desktop
        ? '[aria-label="Google Drive sync settings"]'
        : '[aria-label="Choose graph"]',
      icon: desktop ? Cloud : Layers,
    },
  ];
}

export function OnboardingTour({ onFinish }: { onFinish: (outcome: Outcome) => void }) {
  const [index, setIndex] = useState(0);
  const [layout, setLayout] = useState<{
    target: Bounds | null;
    card: { left: number; top: number };
  }>({ target: null, card: { left: 16, top: 16 } });
  const overlay = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const finish = useRef(onFinish);
  finish.current = onFinish;
  const mask = useId().replaceAll(':', '');
  const tourSteps = steps(Boolean(window.orbis));
  const step = tourSteps[index];
  const last = index === tourSteps.length - 1;
  const Icon = step.icon;

  useLayoutEffect(() => {
    const previousFocus = document.activeElement;
    const siblings = Array.from(overlay.current?.parentElement?.children ?? []).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== overlay.current,
    );
    const previousInert = siblings.map((el) => el.inert);
    siblings.forEach((el) => {
      el.inert = true;
    });
    function keys(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish.current('skipped');
      }
      if (event.key !== 'Tab') return;
      const buttons = Array.from(
        card.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
      );
      const first = buttons[0],
        end = buttons[buttons.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === heading.current)
      ) {
        event.preventDefault();
        end?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === end || !card.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener('keydown', keys, true);
    return () => {
      document.removeEventListener('keydown', keys, true);
      siblings.forEach((el, i) => {
        el.inert = previousInert[i];
      });
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus !== document.body &&
        previousFocus.isConnected
      )
        previousFocus.focus();
      else
        document.querySelector<HTMLButtonElement>('[aria-label="Open tutorial"]')?.focus();
    };
  }, []);

  useLayoutEffect(() => {
    function measure() {
      if (!card.current) return;
      const padding = 16,
        width = card.current.offsetWidth,
        height = card.current.offsetHeight;
      const vw = window.innerWidth,
        vh = window.innerHeight;
      const element = step.target ? document.querySelector<HTMLElement>(step.target) : null;
      const rect = element?.getBoundingClientRect();
      const target =
        rect &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < vh &&
        rect.right > 0 &&
        rect.left < vw
          ? {
              left: Math.max(4, rect.left - 6),
              top: Math.max(4, rect.top - 6),
              width: Math.min(vw - 4, rect.right + 6) - Math.max(4, rect.left - 6),
              height: Math.min(vh - 4, rect.bottom + 6) - Math.max(4, rect.top - 6),
            }
          : null;
      let left = (vw - width) / 2,
        top = (vh - height) / 2;
      if (target) {
        const below = target.top + target.height + 18;
        if (below + height <= vh - padding) {
          left = target.left;
          top = below;
        } else if (target.top - height - 18 >= padding) {
          left = target.left;
          top = target.top - height - 18;
        } else if (target.left + target.width + width + 18 <= vw - padding) {
          left = target.left + target.width + 18;
          top = target.top;
        }
      }
      setLayout({
        target,
        card: {
          left: Math.max(padding, Math.min(left, vw - width - padding)),
          top: Math.max(padding, Math.min(top, vh - height - padding)),
        },
      });
    }
    measure();
    heading.current?.focus();
    const observer = new ResizeObserver(measure);
    if (card.current) observer.observe(card.current);
    const target = step.target ? document.querySelector(step.target) : null;
    if (target) observer.observe(target);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [index, step.target]);

  return (
    <div className="orbis-tour" ref={overlay}>
      <svg className="orbis-tour-scrim" aria-hidden="true">
        <defs>
          <mask id={mask}>
            <rect width="100%" height="100%" fill="white" />
            {layout.target && (
              <rect
                x={layout.target.left}
                y={layout.target.top}
                width={layout.target.width}
                height={layout.target.height}
                rx="10"
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="#050b15"
          fillOpacity=".76"
          mask={`url(#${mask})`}
        />
      </svg>
      {layout.target && (
        <div className="orbis-tour-spotlight" aria-hidden="true" style={layout.target} />
      )}
      <section
        className={`orbis-tour-card ${index === 0 ? 'orbis-tour-welcome' : ''}`}
        ref={card}
        style={layout.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${mask}-title`}
        aria-describedby={`${mask}-body`}
      >
        <header>
          <span className="orbis-tour-count">
            {index === 0 ? 'A QUICK TOUR' : `STEP ${index} OF ${tourSteps.length - 1}`}
          </span>
          <button className="orbis-tour-skip" onClick={() => onFinish('skipped')}>
            Skip tutorial <X size={14} aria-hidden="true" />
          </button>
        </header>
        <div key={index} className="orbis-tour-content">
          <span className="orbis-tour-icon">
            <Icon size={25} aria-hidden="true" />
          </span>
          <h2 id={`${mask}-title`} tabIndex={-1} ref={heading}>
            {step.title}
          </h2>
          <p id={`${mask}-body`}>{step.body}</p>
          {index === 0 && (
            <div className="orbis-tour-workflow" aria-hidden="true">
              {[
                { icon: Plus, text: 'Collect' },
                { icon: BookOpen, text: 'Read & note' },
                { icon: Bot, text: 'Discuss' },
                { icon: Network, text: 'Connect' },
              ].map(({ icon: Item, text }) => (
                <span key={text}>
                  <Item size={22} />
                  <small>{text}</small>
                </span>
              ))}
            </div>
          )}
          <p className="orbis-tour-hint">{step.hint}</p>
        </div>
        <footer>
          <div className="orbis-tour-dots" aria-hidden="true">
            {tourSteps.map((_, i) => (
              <i key={i} className={i === index ? 'active' : ''} />
            ))}
          </div>
          <div className="orbis-tour-actions">
            {index > 0 && (
              <button className="button secondary" onClick={() => setIndex(index - 1)}>
                <ArrowLeft size={15} aria-hidden="true" /> Back
              </button>
            )}
            <button
              className="button primary"
              onClick={() => (last ? onFinish('completed') : setIndex(index + 1))}
            >
              {last ? 'Start using Orbis' : index === 0 ? 'Show me around' : 'Next'}
              {last ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <ArrowRight size={16} aria-hidden="true" />
              )}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
