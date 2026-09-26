# Xelay

Xelay — університетська платформа для обміну знаннями, досвідом і можливостями між студентами та іншими учасниками спільноти.

## Current application

Поточна версія підтримує реєстрацію та вхід, обговорення за темами, відповіді, профілі учасників і сповіщення. Офіційна стрічка факультету, публікація подій, запити на спілкування та приватні чати ще не реалізовані.

## Stack

- React і TypeScript
- Vite
- TanStack Router
- Supabase Auth, Postgres і Storage
- Tailwind CSS

## Local setup

1. Встановіть залежності командою `npm ci`.
2. Додайте `VITE_SUPABASE_URL` і `VITE_SUPABASE_ANON_KEY` до `.env.local`.
3. Запустіть локальний сервер командою `npm run dev`.

Зберіть production-версію командою `npm run build` і перевірте типи командою `npm run lint:types`.
