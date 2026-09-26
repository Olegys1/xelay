import { useState } from 'react'

interface OnboardingModalProps {
onFinish: () => void
}

const steps = [
{
icon: '🎓',
title: 'Вітаємо у Xelay',
description:
'Університетська спільнота для обміну знаннями, досвідом і можливостями.',
},
{
icon: '💬',
title: 'Долучайтеся до спільноти',
description:
'Читайте обговорення за темами й діліться знаннями з іншими студентами.',
},
{
icon: '👥',
title: 'Навчайтеся одне в одного',
description:
'Знайомтеся з людьми, чий досвід та інтереси збігаються з вашими.',
},
{
icon: '📅',
title: 'Відкривайте нові можливості',
description:
'Стежте за новинами університету, подіями, стажуваннями та іншими можливостями.',
},
{
icon: '✨',
title: 'Готові досліджувати?',
description:
'Почніть із теми або знайомства з учасником університетської спільноти.',
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
          Крок {step + 1} із {steps.length}
        </span>

        <button
          onClick={onFinish}
          className="text-sm text-muted-foreground hover:text-foreground transition"
        >
          Пропустити
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
        Назад
      </button>

      {isLast ? (
        <button
          onClick={onFinish}
          className="px-6 py-2.5 bg-foreground text-background rounded-xl font-medium"
        >
          До спільноти
        </button>
      ) : (
        <button
          onClick={() =>
            setStep((s) => s + 1)
          }
          className="px-6 py-2.5 bg-foreground text-background rounded-xl font-medium"
        >
          Далі
        </button>
      )}
    </div>
  </div>
</div>

)
}
