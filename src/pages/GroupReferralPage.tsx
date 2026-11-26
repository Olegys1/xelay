import { Link } from '@tanstack/react-router'

export function GroupReferralPage() {
  return <main className="mx-auto w-full max-w-xl px-5 py-16">
    <h1 className="text-2xl font-semibold">Акцію завершено</h1>
    <p className="mt-4 text-muted-foreground">«Запроси групу» більше не приймає нові запрошення. Уже нараховані подарунки залишаються у вашому акаунті.</p>
    <Link to="/groups" className="mt-6 inline-flex min-h-11 items-center rounded-full bg-primary px-5 text-primary-foreground">До моїх груп</Link>
  </main>
}
