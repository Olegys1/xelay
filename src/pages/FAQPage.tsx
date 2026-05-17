import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

interface FAQItem {
  question: string
  answer: string
}

const FAQ_SECTIONS: { title: string; items: FAQItem[] }[] = [
  {
    title: 'What is Xelay',
    items: [
      {
        question: 'What is Xelay?',
        answer:
          'Xelay is a professional knowledge exchange platform where business experts, entrepreneurs, and professionals can ask questions, share insights, and build their reputation. Think of it as a premium intersection of Reddit, Quora, and LinkedIn — focused entirely on real business value.',
      },
      {
        question: 'Who is Xelay for?',
        answer:
          'Xelay is built for business professionals across all industries and experience levels — from early-stage founders to seasoned executives. Whether you work in B2B, manufacturing, marketing, finance, or startups, Xelay gives you a platform to contribute and learn.',
      },
      {
        question: 'Is Xelay free?',
        answer:
          'Yes, Xelay is completely free to join and use. Our goal is to democratize access to business knowledge. In the future, we may introduce premium features, but the core question and answer functionality will always remain free.',
      },
    ],
  },
  {
    title: 'How it works',
    items: [
      {
        question: 'How do I ask a question?',
        answer:
          'Simply type your question in the ask box on the home page, select the relevant business category, and hit "Ask". Your question will be immediately visible to the community. You must be registered to ask questions.',
      },
      {
        question: 'How does the rating system work?',
        answer:
          'When you answer a question, the question author can like your answer. Each like earns you +1 rating point. Your rating is displayed as stars (★) on your profile and answers — from 1 star (1+ points) up to 5 stars (50+ points). This rewards genuine, high-quality contributions.',
      },
      {
        question: 'Who can like answers?',
        answer:
          'Only the person who asked the question can like answers to that question. This ensures that ratings come from people who genuinely found the answer helpful — not from gaming the system. You also cannot like your own answers.',
      },
      {
        question: 'How do notifications work?',
        answer:
          'You receive notifications when someone answers your question, or when someone likes your answer. Click the bell icon in the header to view your notifications. Unread notifications are highlighted automatically.',
      },
    ],
  },
  {
    title: 'Why Xelay exists',
    items: [
      {
        question: 'What problem does Xelay solve?',
        answer:
          'Most knowledge platforms are either too general (Reddit), too formal (LinkedIn), or too academic (Quora). Xelay fills the gap: a focused, professional environment where real business questions get real answers from practitioners — not bots, not recycled blog posts.',
      },
      {
        question: 'How is Xelay different from other platforms?',
        answer:
          'Xelay is category-focused on business domains (B2B, startups, finance, etc.), has a merit-based rating system tied to actual answer quality, and is designed from the ground up for professionals who value their time. No noise, no distractions — just knowledge exchange.',
      },
      {
        question: 'What is the vision for Xelay?',
        answer:
          'We want to build the definitive platform for business knowledge — where expertise is rewarded, questions get answered by qualified professionals, and the community continuously improves the quality of business decisions worldwide.',
      },
    ],
  },
]

function FAQAccordionItem({ item }: { item: FAQItem }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-border last:border-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between py-5 text-left group"
      >
        <span className="text-sm font-medium text-foreground pr-4 group-hover:text-muted-foreground transition-colors">
          {item.question}
        </span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="pb-5 animate-fade-in">
          <p className="text-sm text-muted-foreground leading-relaxed">{item.answer}</p>
        </div>
      )}
    </div>
  )
}

export function FAQPage() {
  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-6 py-12">
        <div className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-3">
            Frequently Asked Questions
          </h1>
          <p className="text-muted-foreground text-lg">
            Everything you need to know about Xelay
          </p>
        </div>

        <div className="space-y-10">
          {FAQ_SECTIONS.map((section) => (
            <div key={section.title}>
              <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2 pb-2 border-b border-border">
                {section.title}
              </h2>
              <div>
                {section.items.map((item) => (
                  <FAQAccordionItem key={item.question} item={item} />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="mt-16 xelay-card p-8 text-center">
          <h3 className="text-lg font-bold text-foreground mb-2">Still have questions?</h3>
          <p className="text-muted-foreground text-sm mb-4">
            Join Xelay and ask the community directly.
          </p>
          <a
            href="/"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-foreground text-background text-sm font-semibold rounded-lg hover:bg-foreground/85 transition-colors"
          >
            Start Asking →
          </a>
        </div>
      </div>
    </main>
  )
}
