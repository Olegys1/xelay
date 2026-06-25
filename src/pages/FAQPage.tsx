import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

interface FAQItem {
  question: string
  answer: string
}

const FAQ_SECTIONS: {
  title: string
  items: FAQItem[]
}[] = [
  {
    title: 'About Xelay',
    items: [
      {
        question: 'What is Xelay?',
        answer:
          'Xelay is a global knowledge exchange platform where anyone can ask questions, share experience, and learn directly from people who have already solved similar problems.',
      },

      {
        question: 'Why was Xelay created?',
        answer:
          'Finding reliable practical knowledge online is becoming increasingly difficult. Valuable experience is often hidden behind expensive courses, scattered across forums, or buried in social media. Xelay was created to make practical knowledge accessible, searchable, and easy to exchange.',
      },

      {
        question: 'Is Xelay free?',
        answer:
          'Yes. Asking questions, answering, browsing content, and building your profile are completely free.',
      },

      {
        question: 'Do I need an account?',
        answer:
          'No. Anyone can browse questions and answers without signing in. An account is only required if you want to ask questions, publish answers, rate content, or build your profile.',
      },

      {
        question: 'Is Xelay available worldwide?',
        answer:
          'Yes. Xelay is designed as a global platform where people from different countries can exchange knowledge without language barriers or geographic limitations.',
      },
    ],
  },

  {
    title: 'Questions & Answers',
    items: [
      {
        question: 'Who can answer questions?',
        answer:
          'Anyone can contribute. Students, professionals, founders, freelancers, creators, researchers, and industry experts are all welcome to share their knowledge.',
      },

      {
        question: 'Can I upload images?',
        answer:
          'Yes. Questions can include images whenever they help explain a problem or provide additional context.',
      },

      {
        question: 'Can companies use Xelay?',
        answer:
          'Yes. Companies can participate in discussions, share expertise, discover talented people, and contribute to the professional community.',
      },

      {
        question: 'Is Xelay only for business topics?',
        answer:
          'No. While Xelay currently focuses on entrepreneurship, careers, startups, marketing, AI, finance, and professional growth, the platform is designed to expand into many more knowledge areas as the community grows.',
      },
    ],
  },
   {
    title: 'Reputation & Community',
    items: [
      {
        question: 'How does the reputation system work?',
        answer:
          'Helpful answers receive likes from the people who asked the question. Each like increases your reputation and helps others recognize trusted contributors.',
      },

      {
        question: 'What are badges?',
        answer:
          'Badges recognize important milestones and achievements inside the community, such as being an early member, consistently helping others, or becoming a recognized expert.',
      },

      {
        question: 'How do I become an Expert?',
        answer:
          'Expert status is earned naturally through consistent, high-quality contributions and reputation growth. It cannot be requested or purchased.',
      },

      {
        question: 'How is content quality maintained?',
        answer:
          'Content quality is maintained through community ratings, reputation, moderation, and future trust systems designed to reward helpful contributions and reduce low-quality content.',
      },
    ],
  },

  {
    title: 'Languages & Accessibility',
    items: [
      {
        question: 'Can I use Xelay in my own language?',
        answer:
          'Yes. Xelay supports multiple interface languages, allowing people from different countries to comfortably use the platform.',
      },

      {
        question: 'Are questions translated automatically?',
        answer:
          'Automatic translation is currently being introduced. Our goal is to allow users from different countries to communicate naturally while preserving the original content.',
      },

      {
        question: 'Why are there student categories?',
        answer:
          'Student categories help people find internships, teammates, side projects, career advice, and practical opportunities while studying.',
      },
    ],
  },

  {
    title: 'Future',
    items: [
      {
        question: 'Will Xelay always be free?',
        answer:
          'The core experience of asking questions, sharing answers, and learning from the community will always remain free. Additional premium features may be introduced in the future.',
      },

      {
        question: 'Who is building Xelay?',
        answer:
          'Xelay is being built by a small ukrainian team with one mission: making practical knowledge accessible to everyone, regardless of where they live or who they know.',
      },

      {
        question: 'How can I suggest a feature or report a bug?',
        answer:
          'We actively build Xelay together with our community. If you have an idea, found a bug, or want to share feedback, you can do it by using button "Suggest Feature".',
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
