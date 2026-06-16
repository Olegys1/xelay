import { useParams } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

import { Question, Answer } from '../types'
import { QuestionCard } from '../components/QuestionCard'
import { StarRating } from '../components/StarRating'
import { starsFromRating } from '../types'

import {
  MessageCircle,
  HelpCircle,
} from 'lucide-react'

export function PublicProfilePage() {
  const { id } = useParams({
    from: '/user/$id',
  })

  const [profile, setProfile] =
    useState<any>(null)

    const [questions, setQuestions] =
  useState<Question[]>([])

const [answers, setAnswers] =
  useState<Answer[]>([])

const [loading, setLoading] =
  useState(true)

  const [tab, setTab] =
  useState<'questions' | 'answers'>(
    'questions'
  )

  useEffect(() => {
    const loadProfile = async () => {
  try {
    const [
      profileRes,
      questionsRes,
      answersRes,
    ] = await Promise.all([
      supabase
        .from('profiles')
        .select('*')
        .eq('id', id)
        .single(),

      supabase
        .from('questions')
        .select('*')
        .eq('user_id', id)
        .order('created_at', {
          ascending: false,
        }),

      supabase
        .from('answers')
        .select('*')
        .eq('user_id', id)
        .order('created_at', {
          ascending: false,
        }),
    ])

    setProfile(profileRes.data)

    setQuestions(
      questionsRes.data || []
    )

    setAnswers(
      answersRes.data || []
    )
console.log('ANSWERS RAW:')
console.log(answersRes.data)
    console.log(
      'PROFILE:',
      profileRes.data
    )

    console.log(
      'QUESTIONS:',
      questionsRes.data
    )

    console.log(
      'ANSWERS:',
      answersRes.data
    )
  } finally {
    setLoading(false)
  }
}

    loadProfile()
  }, [id])

  useEffect(() => {
  if (!profile) return

  document.title =
    `${profile.full_name} | Xelay`

  const description =
    profile.bio
      ? profile.bio.slice(0, 150)
      : `Public profile of ${profile.full_name} on Xelay`

  let meta =
    document.querySelector(
      'meta[name="description"]'
    )

  if (!meta) {
    meta =
      document.createElement(
        'meta'
      )

    meta.setAttribute(
      'name',
      'description'
    )

    document.head.appendChild(
      meta
    )
  }

  meta.setAttribute(
    'content',
    description
  )

  return () => {
    document.title =
      'Xelay — Knowledge Exchange Platform'
  }
}, [profile])

const initials = profile?.full_name
  ? profile.full_name
      .split(' ')
      .map((n: string) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  : '?'

 return (
  <main className="min-h-screen bg-background">
    <div className="max-w-2xl mx-auto px-6 py-12">

      {loading ? (
        <div className="text-center py-20">
          Loading...
        </div>
      ) : (
        <>
          <div className="xelay-card p-6 mb-8">

            <div className="flex items-center gap-4">

              <div className="w-16 h-16 rounded-full overflow-hidden bg-foreground flex items-center justify-center shrink-0">

                {profile?.avatar_url ? (
                  <img
                    src={profile.avatar_url}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-background text-xl font-bold">
                    {initials}
                  </span>
                )}

              </div>

              <div>
                <h1 className="text-xl font-bold text-foreground">
                  {profile?.full_name}
                </h1>

                <div className="mt-1 flex items-center gap-1.5">

                  <StarRating
                    rating={starsFromRating(
                      profile?.rating || 0
                    )}
                    size="md"
                  />

                  <span className="text-xs text-muted-foreground">
                    ({profile?.rating || 0} pts)
                  </span>

                </div>
              </div>

            </div>

            <div className="mt-5 pt-5 border-t border-border grid grid-cols-2 gap-4 text-sm">

              <div>
                <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">
                  Country
                </p>

                <p className="font-medium text-foreground">
                  {profile?.country || '—'}
                </p>
              </div>

              <div>
                <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">
                  City
                </p>

                <p className="font-medium text-foreground">
                  {profile?.city || '—'}
                </p>
              </div>

              <div>
                <p className="text-muted-foreground text-xs uppercase tracking-wide mb-0.5">
                  Experience
                </p>

                <p className="font-medium text-foreground">
                  {profile?.experience || '—'}
                </p>
              </div>

              <div>
                <p className="text-muted-foreground text-xs uppercase tracking-wide mb-2">
                  Categories
                </p>

                <div className="flex flex-wrap gap-1">

                  {profile?.categories?.length ? (
                    profile.categories.map(
                      (
                        category: string
                      ) => (
                        <span
                          key={category}
                          className="px-2 py-1 text-xs rounded-full border border-border"
                        >
                          {category}
                        </span>
                      )
                    )
                  ) : (
                    <span>—</span>
                  )}

                </div>
              </div>

            </div>

            {profile?.bio && (
              <div className="mt-5 pt-5 border-t border-border">

                <p className="text-muted-foreground text-xs uppercase tracking-wide mb-2">
                  About
                </p>

                <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                  {profile.bio}
                </p>

              </div>
            )}

          </div>

          <div className="grid grid-cols-2 gap-4 mb-8">

            <div className="xelay-card p-4 text-center">

              <HelpCircle
                size={20}
                className="mx-auto mb-1 text-muted-foreground"
              />

              <p className="text-2xl font-bold text-foreground">
                {questions.length}
              </p>

              <p className="text-sm text-muted-foreground">
                Questions
              </p>

            </div>

            <div className="xelay-card p-4 text-center">

              <MessageCircle
                size={20}
                className="mx-auto mb-1 text-muted-foreground"
              />

              <p className="text-2xl font-bold text-foreground">
                {answers.length}
              </p>

              <p className="text-sm text-muted-foreground">
                Answers
              </p>

            </div>

          </div>

          <div className="flex border-b border-border mb-6">

            {(
              ['questions', 'answers'] as const
            ).map((t) => (
              <button
                key={t}
                onClick={() =>
                  setTab(t)
                }
                className={`flex-1 py-3 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                  tab === t
                    ? 'border-foreground text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t === 'questions'
                  ? `Questions (${questions.length})`
                  : `Answers (${answers.length})`}
              </button>
            ))}

          </div>

          {tab === 'questions' ? (
            questions.length === 0 ? (
              <p className="text-center py-10 text-muted-foreground">
                No questions yet
              </p>
            ) : (
              <div className="space-y-4">

                {questions.map((q) => (
                  <QuestionCard
                    key={q.id}
                    question={q}
                    showAnswerButton={false}
                  />
                ))}

              </div>
            )
          ) : (
            <div className="space-y-4">

             {answers.map((ans) => (
  <div
    key={ans.id}
    className="xelay-card p-5"
  >
    <p className="whitespace-pre-wrap">
      {(ans as any).content}
    </p>
  </div>
))}

            </div>
          )}

        </>
      )}

    </div>
  </main>
)
}