import { useId } from 'react'

type Props = {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  invalid?: boolean
  name?: string
}

export function PrivacyConsent({ checked, onChange, disabled = false, invalid = false, name = 'privacy-consent' }: Props) {
  const id = useId()
  const helpId = `${id}-help`
  return (
    <div data-auth-field={name} className={`rounded-xl border p-3.5 ${invalid ? 'border-destructive bg-destructive/5' : 'border-border bg-muted/25'}`}>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed text-foreground">
        <input
          id={id}
          name={name}
          type="checkbox"
          required
          checked={checked}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={helpId}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
        />
        <span>Надаю згоду на обробку моїх персональних даних для створення й обслуговування облікового запису, роботи профілю та обраних мною функцій Xelay на умовах <a href="/personal-data-consent" target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-4 hover:text-primary/80">Згоди на обробку персональних даних</a>. Ознайомився / ознайомилася з <a href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-4 hover:text-primary/80">Політикою конфіденційності</a>.</span>
      </label>
      <p id={helpId} className="mt-2 text-xs leading-relaxed text-muted-foreground">Документи відкриються в новій вкладці — заповнені поля залишаться у формі. Ця згода не поширюється на рекламні розсилки чи передачу резюме роботодавцям.</p>
    </div>
  )
}
