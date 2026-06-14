import { useState } from 'react'

interface OnboardingModalProps {
onFinish: () => void
}

const steps = [
{
icon: '🚀',
title: 'Welcome to Xelay',
description:
'A place where founders, freelancers, marketers and builders exchange real experience.',
},
{
icon: '❓',
title: 'Ask Questions',
description:
'Get practical answers from people who have already solved the problem you are facing.',
},
{
icon: '💡',
title: 'Share What Works',
description:
'Help others by sharing your experience, lessons learned and proven solutions.',
},
{
icon: '⭐',
title: 'Build Reputation',
description:
'Earn rating points when your answers help other members of the community.',
},
{
icon: '🔥',
title: 'Ready to Start?',
description:
'Ask your first question or join an existing discussion.',
},
]

export function OnboardingModal({
onFinish,
}: OnboardingModalProps) {
const [step, setStep] = useState(0)

const isLast =
step === steps.length - 1

const progress =
((step + 1) / steps.length) * 100

return ( <div className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"> <div className="w-full max-w-lg bg-background border border-border rounded-3xl p-8 shadow-2xl">


    <div className="mb-8">
      <div className="flex justify-between items-center mb-3">
        <span className="text-sm text-muted-foreground">
          Step {step + 1} of {steps.length}
        </span>

        <button
          onClick={onFinish}
          className="text-sm text-muted-foreground hover:text-foreground transition"
        >
          Skip
        </button>
      </div>

      <div className="w-full h-2 bg-border rounded-full overflow-hidden">
        <div
          className="h-full bg-foreground transition-all duration-500"
          style={{
            width: `${progress}%`,
          }}
        />
      </div>
    </div>

    <div className="text-center mb-10">
      <div className="text-6xl mb-5">
        {steps[step].icon}
      </div>

      <h2 className="text-3xl font-bold mb-4">
        {steps[step].title}
      </h2>

      <p className="text-muted-foreground leading-relaxed">
        {steps[step].description}
      </p>
    </div>

    <div className="flex justify-between items-center">
      <button
        disabled={step === 0}
        onClick={() =>
          setStep((s) => s - 1)
        }
        className="px-5 py-2.5 border border-border rounded-xl disabled:opacity-40"
      >
        Back
      </button>

      {isLast ? (
        <button
          onClick={onFinish}
          className="px-6 py-2.5 bg-foreground text-background rounded-xl font-medium"
        >
          Start Exploring
        </button>
      ) : (
        <button
          onClick={() =>
            setStep((s) => s + 1)
          }
          className="px-6 py-2.5 bg-foreground text-background rounded-xl font-medium"
        >
          Next
        </button>
      )}
    </div>
  </div>
</div>

)
}
