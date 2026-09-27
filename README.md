# Xelay

Xelay — університетська платформа для обміну знаннями, досвідом і можливостями між студентами та іншими учасниками спільноти.

## Current application

Поточна версія підтримує реєстрацію та вхід, обговорення за темами, відповіді, пошук учасників за ніком, розширені профілі, запити на спілкування та особисті чати після прийняття запиту. Офіційна стрічка факультету й публікація подій ще не реалізовані.

Перед використанням нових функцій послідовно застосуйте міграції `supabase/migrations/202609260001_profile_connections_messages.sql` і `supabase/migrations/202609270001_usernames.sql` у SQL Editor відповідного проєкту Supabase. Пошук працює за ніком; особистий чат створюється лише після прийняття запиту його отримувачем.

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
