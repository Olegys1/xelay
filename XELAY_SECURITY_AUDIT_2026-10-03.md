# Аудит безопасности Xelay перед публичным запуском

**Дата:** 3 октября 2026 года. **Версия:** `main / f2ffdce34b4d8bb2de6515847c095871f24b5079` — UI.  
**Рабочий сайт:** [www.xelay.ink](https://www.xelay.ink). **Vercel:** `xelay-s-projects / xelay`. **Supabase:** `Xelay mvp / baohfpadxvhqhhjjqtil`.

## Итог для владельцев

**Текущая оценка: 4/10. Массовый запуск и университетский PR рекомендую отложить до устранения проблем высокого приоритета.** Это экспертная оценка готовности, не CVSS, сертификат или вероятность взлома.

Подтверждены пять проблем высокого приоритета: изменение чужих вопросов и ответов, анонимное изменение связей изображений, удаление/перезапись чужих публичных файлов и два способа вывести из строя интерфейс чата датой сообщения или опроса. Дополнительно: у двух администраторов платформы нет подтверждённого второго фактора; в панели Supabase Free отсутствуют доступные проекту ежедневные резервные копии; защита от автоматизированного злоупотребления требует усиления.

В проверенном коде и рабочей схеме не обнаружен обход платного доступа, выдачи ADMIN или прав старосты/заместителя на учебные материалы. Не подтверждены захват аккаунта, подделка успешной оплаты или чтение чужой приватной переписки. Это ограниченный результат проверки, а не гарантия отсутствия таких ошибок.

По запросу владельца **исправления отложены до отдельного сигнала**. Приложение, политики базы, роли, ключи, настройки облачных сервисов и деплои не изменялись. Созданы только локальные материалы аудита; SQL Editor мог сохранить приватные SELECT-запросы.

## Метод и покрытие

Проверены frontend, все серверные API, SQL-миграции, зависимости, настройки рабочего Supabase и Vercel, публичные HTTP-ответы и реально опубликованный JavaScript.

| Зона | Что сделано |
| --- | --- |
| Код и история | Проверка 214 текстовых файлов и 688 исторических текстовых Git-объектов на признаки секретов; анализ авторизации, входа, восстановления, сообщений, публикаций, файлов, новостей, учебных групп, оплаты |
| Рабочая база | Получены определения 224 функций, политики public и Storage, grants, ограничения 80 таблиц, включённые триггеры и состав Realtime-публикаций |
| Сверка миграций | Актуальные функции учебных групп, оплаты, профилей/новостей и чатов сопоставлены с production; отдельные legacy-защиты проверены по фактическому каталогу |
| Рабочий сайт | Безопасные GET и пустые неавторизованные POST, проверка редиректов, заголовков, недоступности секретных файлов; запросы к таблицам с limit=0 без чтения записей |
| Настройки | Email confirmation, redirects, MFA, сессии, лимиты Auth, CAPTCHA, резервные копии; актуальная версия Vercel, Firewall и Deployment Protection |
| Зависимости | npm audit без изменения пакетов; оценка достижимости уязвимых путей |

**Уровни доказательств:**

- **Production + код:** фактические права, политики, функции и ограничения рабочего проекта подтверждают сценарий; разрушительное действие не выполнялось.
- **Локальное воспроизведение:** опасное значение обработано изолированным кодом без записи в рабочие чаты.
- **Статический сценарий:** вывод по коду; требуется воспроизвести с тестовыми пользователями в отдельном окружении.
- **Операционный пробел:** настройка/возможность восстановления не подтверждена; сам по себе не доказывает успешную атаку.

## Пять проблем высокого приоритета — закрыть до запуска

### SEC-01 / P1: любой вошедший пользователь с действующей сессией может менять чужие вопросы и ответы

**Доказательства: production + код.** UPDATE-политика `answers` допускает строки без проверки владельца. UPDATE-политика `questions` требует только наличие вошедшего пользователя. Клиенту разрешено менять все соответствующие колонки, включая `user_id`, текст и поля авторства. Дополнительных ограничительных политик, запрещающих такой сценарий, не найдено. Триггер вопросов защищает счётчик ответов, но не владельца.

**Последствия:** подмена содержания и автора чужой публикации. Изменение `user_id` на себя позволяет затем воспользоваться штатной процедурой удаления собственного контента. Это риск для целостности контента и связанных ответов.

**Исправление:** UPDATE только для владельца/явно разрешённого модератора; неизменяемые `id`, `user_id` и системные поля; разрешённый список редактируемых колонок; модераторские операции через проверяемый серверный путь. Проверить существующие записи на несогласованное авторство.

**Проверка после исправления:** пользователь B не может изменить текст, владельца, дату и счётчики публикации A или удалить её после подмены владельца; допустимые собственные правки продолжают работать.

**Ссылки:** [answers UPDATE](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-policies.csv:13), [questions UPDATE](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-policies.csv:45), [права колонок answers](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-column-grants.csv:17), [права колонок questions](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-column-grants.csv:48), [триггеры answers](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-guards.csv:58), [триггеры questions](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-guards.csv:80), [удаление собственного вопроса](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/supabase/migrations/202609300004_community_deletion.sql:297).

### SEC-02 / P1: изображения чужих вопросов/ответов можно менять даже без входа

**Доказательства: production + код.** Для `question_images` и `answer_images` действуют публичные ALL-политики с `true` и клиентские grants на запись/удаление. Проверка существования родительской записи не проверяет её владельца.

**Последствия:** посетитель без аккаунта может добавлять, подменять или удалять ссылки на изображения в чужих публикациях. Доступ к обычным вопросам и ответам не делает такую запись допустимой.

**Исправление:** сохранить публичное чтение там, где оно нужно продукту; INSERT/UPDATE/DELETE разрешать владельцу родительского вопроса/ответа и модератору. Проверять принадлежность пути Storage автору, допустимый URL и неизменяемый parent ID.

**Проверка:** анонимная запись отклоняется; B не меняет вложения A; A добавляет и удаляет собственное изображение.

**Ссылки:** [answer_images ALL](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-policies.csv:6), [question_images ALL](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-policies.csv:37), [grants answer_images](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-grants.csv:5), [grants question_images](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-grants.csv:42), [проверка родителя](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-guards.csv:50). Анонимная доступность API проверена без чтения строк: [наблюдения live API](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/live-bundle-checks.json).

### SEC-03 / P1: вошедший пользователь с действующей сессией может удалить/перезаписать чужие публичные файлы

**Доказательства: production + код.** Политики `avatars` для INSERT/UPDATE/DELETE проверяют bucket, но не владельца или его каталог. DELETE в `answer-media` также разрешён любому вошедшему пользователю; INSERT позволяет повторно создать удалённый публичный путь.

**Последствия:** подмена аватаров и удаление/замена изображений публикаций при известном публичном пути. И вопросы, и ответы в текущем интерфейсе загружают изображения в `answer-media`. Это отдельная проблема от прав на строки `*_images`.

**Исправление:** для каждой операции проверять owner и пространство путей пользователя. Учесть существующие файлы и их старые пути, чтобы миграция не лишила владельцев доступа. Ввести ограничения типа/размера и запрет произвольного занятого пути.

**Проверка:** B не может удалить, upsert или повторно создать путь A; собственные загрузки и замена аватара работают.

**Ссылки:** [avatars DELETE/UPDATE/INSERT](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-policies.csv:53), [answer-media DELETE](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-policies.csv:111), [answer-media INSERT](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-policies.csv:113), [изображения вопроса](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/src/components/AskQuestionForm.tsx:109), [изображения ответа](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/src/pages/QuestionDetailPage.tsx:322), [upsert аватара](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/src/components/ProfileSettingsModal.tsx:185).

### SEC-04 / P1: специальная дата сообщения может надолго сломать экран директа получателя

**Доказательства: production + локальное воспроизведение.** Клиент может передать `messages.created_at` при INSERT. Рабочие политики, CHECK-ограничения и единственный BEFORE INSERT guard не задают допустимый диапазон и не заменяют дату серверным временем. PostgreSQL принимает специальные timestamp-значения, которые JavaScript не умеет отображать.

**Последствия:** участник существующего диалога отправляет запись с такой датой; `formatDistanceToNow`/форматирование даты вызывает исключение в списке или ленте сообщений. Soft-delete сохраняет дату, поэтому удаление текста не гарантирует восстановления интерфейса. Обычная авторизация диалога при этом соблюдается — атакующий должен иметь право отправить сообщение жертве.

**Исправление:** дата создания назначается сервером и не меняется клиентом; CHECK на конечный разумный диапазон; безопасное форматирование с fallback в UI. Найти и исправить уже существующие некорректные даты, если они есть.

**Проверка:** некорректные даты отклоняются/нормализуются; старые плохие записи не ломают список диалогов, ленту и tombstone.

**Ссылки:** [messages schema](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-schema.csv:4), [messages INSERT](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-grants.csv:31), [messages policies](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-all-policies.csv:30), [messages CHECK/FK](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-constraints.csv:36), [reply guard](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-guards.csv:19), [messages triggers](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-guards.csv:71), [форматирование даты в UI](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/src/pages/MessagesPage.tsx:1458).

### SEC-05 / P1: дата завершения опроса вне диапазона JavaScript ломает чат

**Доказательства: production + локальное воспроизведение.** Рабочий `xelay_chat_publish` проверяет конечность и будущую дату `closes_at`, но не задаёт верхнюю границу. Допустимый диапазон PostgreSQL шире диапазона JavaScript Date. Изолированная проверка конечной даты за пределами JS дала Invalid Date и RangeError.

**Последствия:** подписчик «Учасник», которому разрешено публиковать в соответствующей группе/канале, может создать опрос, выводящий из строя отображение публикаций у читателей. Это не обход подписки — действующее право публикации уже требуется.

**Исправление:** разумный предел даты завершения в RPC и CHECK; общий безопасный formatter в UI; обработка старых некорректных записей.

**Проверка:** слишком далёкая дата отклоняется; её наличие в старой карточке не ломает чат и другие публикации.

**Ссылки:** [фактическая проверка closes_at](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-functions.csv:2319), [chat_publications constraints](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-constraints.csv:23), [SQL публикации опроса](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/supabase/migrations/202610020011_chat_publications_faculty_admins.sql:315), [форматирование closes_at](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/src/components/ChatPublicationCard.tsx:144).

## Другие проблемы и меры до публичного запуска

### SEC-06 / P2: администраторы платформы без второго фактора

**Подтверждено агрегатом production:** 2 аккаунта с ролью ADMIN, 0 с подтверждённым MFA-фактором. TOTP в проекте включён, но интерфейс входа и серверные административные проверки не обеспечивают обязательный AAL2.

Знание/утечка пароля администратора даёт слишком сильный доступ. Наличие переключателя TOTP в панели само по себе не защищает админские действия.

**Мера:** внедрить enrollment/challenge, требовать AAL2 для привилегированных RPC/API, продумать восстановление доступа. Отдельно проверить 2FA владельцев Supabase, Vercel и GitHub, состав команд, активные токены и права приложений — эти внешние аккаунты полностью не проаудированы. Применение MFA требует серверных правил, что описано в [документации Supabase](https://supabase.com/docs/guides/auth/auth-mfa).

**Доказательства:** [снимок настроек и агрегат MFA](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-settings.json); роль ADMIN проверяется актуальными функциями из [каталога функций](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-functions.csv); в исходниках не найдено обязательной проверки `aal2`.

### SEC-07 / P2: не подтверждено восстановление рабочей базы и файлов

Панель Supabase показывает Free и отсутствие доступных проекту ежедневных backup. Наличие внешних копий и успешного пробного восстановления не подтверждено.

**Мера до запуска:** настроить регулярные защищённые копии БД и объектов Storage вне рабочего проекта, срок хранения, контроль успешности и восстановление в отдельном окружении. Согласовать допустимую потерю последних изменений и срок восстановления. При выборе платного backup отдельно копировать файлы: backup базы не включает объекты Storage. [Supabase: Database Backups](https://supabase.com/docs/guides/platform/backups).

**Доказательства:** [наблюдение страницы Backups](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-settings.json). Это риск доступности, а не подтверждение потери данных.

### SEC-08 / P2: подмена активного аккаунта через session в ссылке

**Статический сценарий:** `detectSessionInUrl: true`, постоянное хранение сессии и не заданный явно PKCE допускают принятие токенов из входящего URL. В установленном SDK по умолчанию используется implicit flow. Ссылка с действующей сессией атакующего способна переключить посетителя в аккаунт атакующего без ожидаемой привязки к начатому входу.

**Последствия:** пользователь считает аккаунт своим и записывает заметки, данные профиля или совершает действия в чужом аккаунте. Кража его прежних токенов из этого сценария не следует.

**Мера:** привязанный к инициированному входу PKCE/code flow, безопасная обработка callback и подтверждение неожиданной смены личности. Проверить email recovery отдельно, чтобы не сломать существующую защиту.

**Ссылка:** [настройки сессии](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/src/lib/supabase.ts:12). Требуется воспроизведение двумя тестовыми аккаунтами вне production.

### SEC-09 / P2: редактор может подменить автора новости

**Production + код:** scope-политика `news_posts` ограничивает факультет/университет, но прямой UPDATE позволяет изменить `published_by`. Серверная процедура с разрешённым списком полей не закрывает прямой table PATCH.

**Мера:** неизменяемое авторство, ID и проверка смены scope; клиенту только разрешённые колонки или исключительно RPC. Действия редакторов журналировать.

**Доказательства:** [news_posts scope policy](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-policies.csv:24), [news_posts UPDATE grants](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-grants.csv:34), [триггеры news_posts](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-guards.csv:73), [RPC обновления новости](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/supabase/migrations/202609300003_news_management.sql:84). Выход за разрешённый факультет не подтверждён.

### SEC-10 / P2: изменение рейтинга и показателей доверия

**Production + код:** legacy `increment_profile_rating(uuid)` — SECURITY DEFINER, доступна публичным ролям и не проверяет вызывающего/основание начисления. Собственный профиль допускает UPDATE `rating` и `trust_score`.

**Мера:** вычисляемые сервером поля сделать недоступными клиенту; отозвать публичный EXECUTE, начислять по проверяемому уникальному событию. Проверить фактические показатели перед использованием в продукте.

**Доказательства:** [increment_profile_rating](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-guards.csv:5), [profiles UPDATE](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-column-grants.csv:32), [profiles triggers](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-guards.csv:77). Эти показатели сейчас не выдают ADMIN или платный доступ.

### SEC-11 / P2: прямые сообщения и запросы на общение недостаточно ограничены от спама

Клиентский интерфейс не является лимитом для прямого обращения к Supabase. У INSERT прямых сообщений не найден серверный лимит частоты/дневного объёма, создание сообщения инициирует уведомления. Факультетские/групповые публикации уже имеют отдельные проверки — их наличие не защищает директ.

**Мера:** атомарные лимиты по пользователю/диалогу, контроль очереди уведомлений, лимит заявок и повторных обращений, механизм блокировки злоупотреблений. Проверять ограничения параллельными запросами в тестовом окружении.

**Ссылки:** [messages INSERT policy](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/supabase/migrations/202609280001_universities_news_admin.sql:619), [уведомление при сообщении](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/supabase/migrations/202609260001_profile_connections_messages.sql:304), [production messages policies](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-all-policies.csv:30). Email-уведомления имеют debounce и часовой лимит; бесконечная рассылка почты этим аудитом не подтверждена.

### SEC-12 / P2: лимиты файлов в UI можно обойти; нет общей квоты пользователя

Лимиты количества/суммарного размера вложений директа проверяются преимущественно в UI. Политика загрузки `xelay-chat-media` разрешает вошедшему пользователю собственный каталог без обязательного наличия конкретного чата/публикации. Ограничения общего объёма, частоты и обязательной уборки неприкреплённых объектов недостаточны.

В legacy buckets `avatars` и `question-images` нет собственных MIME/size ограничений; у `answer-media` нет списка MIME, заданный bucket-limit — 100 MiB. Это не означает фактическую возможность загрузить 100 MiB в Free: глобальный лимит сервиса может быть меньше.

**Мера:** серверные квоты по количеству/байтам/частоте, проверка типа и размера, резервирование разрешённой загрузки, привязка к существующему доступному объекту, TTL и уборка незавершённых загрузок; оповещения по затратам. На Free глобальный предел не может превышать 50 MB, по [документации Supabase](https://supabase.com/docs/guides/storage/uploads/file-limits).

**Ссылки:** [INSERT вложений директа](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/supabase/migrations/202609280003_private_message_media.sql:51), [bucket чатов](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/supabase/migrations/202610020002_community_chats.sql:237), [upload policy чатов](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/supabase/migrations/202610020002_community_chats.sql:925), [все Storage policies](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-policies.csv). Массовая загрузка на рабочий сайт не выполнялась.

### SEC-13 / P2: удаление приватного вложения может оставлять файл в Storage

**Статический сценарий с подтверждёнными production policies:** UI сначала soft-delete сообщения, триггер удаляет связи вложений, затем UI вызывает Storage.remove. SELECT на файл зависит от существующей связи с неудалённым сообщением. После удаления связи путь перестаёт быть видимым; стандартное удаление Storage требует соответствующих прав чтения/удаления. Пустой результат удаления не проверяется как отсутствие фактического удаления.

**Мера:** серверная последовательность удаления либо временная квитанция уборки, проверка действительно удалённых путей, повторные попытки и сборщик потерянных файлов. Проверить аналогичный случай незавершённой загрузки. Старый signed URL живёт до установленного срока — мгновенное прекращение доступа не гарантируется.

**Ссылки:** [SELECT файла](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/supabase/migrations/202609280003_private_message_media.sql:88), [удаление связи](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/supabase/migrations/202609280003_private_message_media.sql:123), [последовательность удаления](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/src/pages/MessagesPage.tsx:1014). Полный сценарий Storage.remove в production не воспроизводился; чтение чужого приватного файла не подтверждено.

### SEC-14 / P2: отзыв заявки позволяет лишний раз обновлять приватный чат

Рабочий `xelay_chat_cancel_request` обновляет `chat_spaces.updated_at`, даже если собственной ожидающей заявки нет. Зная UUID чата, вошедший пользователь может вызывать ненужные блокировки/обновления и потенциальный Realtime-шум.

**Мера:** проверить наличие собственной заявки и обновлять чат только после успешного изменения строки; добавить частотный лимит. Содержимое чата этим RPC не раскрывается.

**Ссылки:** [фактический cancel_request](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-functions.csv:1320), [исходный cancel_request](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/supabase/migrations/202610020002_community_chats.sql:730).

### SEC-15 / P2: проверка существования скрытого email через свой профиль

**Статический сценарий, подтверждённая схема:** `profiles.email` имеет UNIQUE, а собственную строку можно обновить включая email. Конфликт `23505` при подстановке предполагаемого адреса отличается от успешной операции и позволяет проверить его присутствие в скрытом профиле.

**Мера:** хранить канонический email как серверное поле, менять через подтверждённый Auth flow, унифицировать ошибки и ограничивать частоту. Email работника уведомлений берётся из Auth — подмена профиля не подтверждает перенаправление этих уведомлений.

**Доказательства:** [UNIQUE email](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-constraints.csv:47), [права профиля](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-column-grants.csv:32), [политики профиля](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-all-policies.csv:39). Захват аккаунта не следует из этой находки; запросы с реальными адресами не выполнялись.

### SEC-16 / P2 preventive: legacy таблица с email открыта для чтения

`xelay_users` имеет публичное чтение всей строки, включая колонку email. **В рабочей таблице сейчас 0 строк и 0 email**, подтверждено агрегатным SELECT. Текущая утечка адресов не установлена.

**Мера:** закрыть или убрать неиспользуемый endpoint до будущего импорта/backfill.

**Доказательства:** [xelay_users columns](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-schema.csv:8), [публичная SELECT policy](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-policies.csv:49), [агрегат пустой таблицы](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-critical-functions.csv).

### SEC-17 / P2: отсутствуют часть защитных заголовков браузера

Live HTML содержит HSTS и `nosniff`. CSP/CSP-Report-Only, X-Frame-Options, Referrer-Policy и Permissions-Policy отсутствуют. Защита от встраивания страницы в чужой iframe не задана; возможен clickjacking. Отсутствие CSP само по себе не доказывает XSS, и достижимых опасных HTML-sinks в рассмотренном frontend не найдено.

**Мера:** `frame-ancestors` и совместимая защита iframe; CSP с учётом Supabase, WayForPay и реально используемых ресурсов; политика referrer и разрешений браузера. CSP сначала проверить на совместимость, затем включить enforcement. Сохранить рабочие callback/webhook оплаты.

**Доказательства:** [заголовки production](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/live-observations.json), [текущие headers](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/vercel.json:38).

### SEC-18 / P2: устаревшие зависимости и открытый dev server

npm audit сообщает **20 затронутых пакетов/цепочек: 16 high, 2 moderate, 2 low, 0 critical**. Это не двадцать независимых подтверждённых уязвимостей работающего сайта. Основная достижимость — разработка, сборка, обработка специальных исходников, а не обычные пользовательские сообщения.

- Vite `8.0.13`: известная high-уязвимость Windows dev server исправлена в `8.0.16`. Конфигурация `host: true / allowedHosts: true` расширяет риск при запущенном локальном сервере. [GitHub advisory](https://github.com/advisories/GHSA-fx2h-pf6j-xcff).
- PostCSS: уязвимость обработки source map с чтением файлов; работа с вредоносным build-input требует отдельного пути попадания. Пользовательские статьи/сообщения через PostCSS не обрабатываются. [GitHub advisory](https://github.com/advisories/GHSA-6g55-p6wh-862q).
- Прочие цепочки включают glob/brace-инструменты, browserslist, stylelint/tailwind и связанные зависимости; их роли и конкретные рекомендации сохранены в JSON.

**Мера:** совместимые patched версии и повторная проверка сборки; dev server привязать к localhost и разрешённым hosts. Не использовать слепо `audit fix --force`: часть предложений меняет major или откатывает инструмент.

**Доказательства:** [полный npm audit](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/dependencies.json), [dev server](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/vite.config.ts:26), [зафиксированные версии](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/package-lock.json).

### Дополнительные P3 и операционные пункты

| Пункт | Статус и действие |
| --- | --- |
| Квитанция удаления семинарного файла | При повторном использовании прежнего object_path старая cleanup-квитанция может пережить замену объекта. UI обычно создаёт UUID, поэтому риск условный. Привязать к версии объекта и удалить квитанцию атомарно с удалением файла. См. [cleanup receipts](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/supabase/migrations/202610020008_study_group_deputies.sql:704) |
| Seed админов факультетского чата по изменяемому username | Это одноразовая применённая миграция, а не текущая автоматическая выдача прав при смене ника. При повторном выполнении username мог бы принадлежать другому человеку. Привязать последующие выдачи к подтверждённому неизменяемому user UUID. См. [seed администраторов](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/supabase/migrations/202610020011_chat_publications_faculty_admins.sql:125) |
| Профилактика утечки env | Признаков секретов в доступной истории нет; расширить ignore для общих .env/.env.production и добавить контроль перед коммитом. Значения ключей в отчёте отсутствуют |
| Email-worker | Пустые неавторизованные запросы к email/retry вернули 503 «ещё не настроено», то есть закрытый отказ. В Vercel за 6 часов 365 вызовов retry и 26 email отмечены с 100% ошибок. Требуется сверка настройки worker/trigger и контролируемый тест доставки; открытый relay не обнаружен. См. [агрегат функций](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/vercel-function-aggregate.json) |
| Sitemap | Серверный запрос без явного paging/cache и formatter даты заслуживают ограничений по объёму и безопасного fallback. Нагрузка и отказ большого набора данных не воспроизводились |
| Мониторинг и реагирование | Определить владельца реакции, alerts на 5xx/ошибки оплаты/очередь/квоты, инструкции отзыва сессий и временного ограничения записи. Отключение новых покупок само по себе не закрывает SEC-01–03 |

## Проверенные настройки рабочего окружения

### Supabase

| Настройка | Наблюдение |
| --- | --- |
| RLS | Включён на всех 80 экспортированных public/storage таблицах; наличие RLS не означает корректность каждой политики |
| Realtime | Обе публикации имеют puballtables=false; chat_poll_votes не опубликована |
| Email confirmation | Включено; anonymous sign-ins и manual identity linking выключены |
| Провайдеры входа | В панели включён Email |
| Secure email change | Включено |
| Secure password change / требование текущего пароля | Выключены; усилить чувствительную смену пароля через отдельный проверенный flow |
| CAPTCHA | Выключена |
| Проверка утекших паролей | Выключена; соответствующая настройка требует Pro |
| Redirect allowlist | Четыре точных URL: www/non-www auth/callback и reset-password; широких wildcard нет |
| Sign-up/sign-in | 30 запросов за 5 минут на IP |
| Token verification | 30 запросов за 5 минут на IP |
| Refresh | 150 запросов за 5 минут на IP |
| Access token | 3600 секунд |
| Refresh replay detection | Включено, reuse interval 10 секунд |
| Session timebox / inactivity timeout | Не ограничены; часть управления недоступна на Free |
| MFA | TOTP включён, max factors 10; подтверждённых факторов у ADMIN: 0 из 2 |
| AAL1 после enrollment | Ограничение длительности включено; без enrollment это не защищает текущих администраторов |
| Backup | В панели Free нет доступных проекту ежедневных backup; внешние копии не проверены |

Не считывались скрытые значения SMTP/ключей и поля, которые инструмент редактировал как чувствительные. Поэтому минимальная серверная длина пароля и почасовой email-limit не подтверждены числом.

Первая мера против автоматизации: согласовать CAPTCHA и серверные квоты с ожидаемым набором студентов. Vercel Firewall не защищает обращения напрямую к Supabase. Не включать блокировки, которые перекроют WayForPay webhook или работу восстановления аккаунта.

### Vercel и production

- Корректный проект `xelay`, production Ready, source `main / f2ffdce`, домен `www.xelay.ink`. Старый Blink-проект не является проверенным рабочим deployment.
- System Mitigations/Firewall активны; Custom Rules — 0; Bot Protection — Inactive. В панели видны срабатывания DDoS-защиты; нагрузочный тест не выполнялся.
- Deployment Protection: Vercel Authentication включена, Standard Protection; Protected Sourcemaps включены; дополнительных exceptions/bypass secrets на просмотренной странице не показано. Все shareable links не инвентаризировались.
- HTTP перенаправляет на HTTPS; bare-host на www.
- Публичный статус оплаты: live, checkoutAvailable=true, «Учасник» 100 грн / 1 месяц, группа 750 грн / 12 месяцев, без автоматического продления.
- Агрегат функций за последние 6 часов: /api/notifications/retry — 365 вызовов, 100% ошибок; /api/notifications/email — 26 вызовов, 100% ошибок. Все показанные платёжные маршруты — 0% ошибок; это не доказывает успешность каждой транзакции. Вместе с ответом 503 «ещё не настроено» на безопасные запросы это требует отдельной проверки настройки и доставки почты. Журналы конкретных запросов и пользовательские данные не читались.

**Доказательства:** [снимок настроек](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-settings.json), [HTTP/оплата](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/live-observations.json), [реальный JS bundle](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/live-bundle-checks.json).

## Что уже защищено и проверено

### Оплата и подписки

Сервер подписывает checkout, фиксирует цены и проверяет ответ WayForPay: подпись сравнивается безопасным способом, проверяются merchant, заказ, сумма, валюта и режим. Успешный redirect браузера не выдаёт доступ.

Выдача entitlement/лицензии выполняется закрытыми серверными процедурами с блокировкой и идемпотентностью. Test orders не дают live-доступ. Reconcile проверяет владельца заказа и ограничивает обращение к провайдеру. Актуальные 24 billing-функции совпадают с production, включая годовой доступ группы. Анонимные checkout/reconcile отклонены 401, пустой неподписанный webhook — 400.

При этом новая реальная оплата/возврат в ходе аудита не выполнялись, панель WayForPay и полномочия сотрудников мерчанта отдельно не проверялись. Нельзя на основании этого отчёта обещать отсутствие всех ошибок финансового цикла.

**Ссылки:** [подписи и проверки](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/server/billing.ts:93), [reconcile](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/server/billing.ts:176), [return handler](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/api/billing/return.ts), [рабочие billing functions](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-functions.csv).

### Учебные группы

Актуальные 77 функций группы/заместителей/расписания/ДЗ/семинаров сопоставлены с последними SQL-определениями. В рабочей схеме действуют ограничения и триггеры: обычный участник не может менять пары, расписание, ДЗ и семинары; заместитель действует только по назначенным старостой разрешениям. Удаление членства отзывает соответствующие полномочия. Старые процедуры заявок на заместителя закрыты.

Проверены ограничения 16 профильных таблиц и 121 CHECK/FK/UNIQUE в этой зоне, DEFAULT replica identity и состав Realtime. Новых обходов прав обычного участника не выявлено.

### Чаты, каналы, новости, профили

- 75 `xelay_chat_*` функций совпадают с последними миграциями. Внутренние lock/json/activation helpers не открыты клиентам; доступные RPC проверяют пользователя/роль.
- Прямые сообщения читаются участниками диалога; посторонний пользователь не получил доступ по рассмотренным правилам.
- Опросы и статьи требуют платный доступ и право публикации. Голосование/чтение не зависит от покупки; голоса не доступны прямым grants и не опубликованы через Realtime.
- `poll_voters` отказывает для анонимного опроса; публичные карточки возвращают counts/my_votes без списка личностей.
- Публичные профили возвращаются через ограниченный список колонок без email. Роль ADMIN и entitlement не являются саморедактируемыми полями профиля.
- Права редакторов scoped по университету/факультету; обход чужого scope не обнаружен. Проблема SEC-09 касается автора внутри разрешённого scope.
- Поиск имеет атомарную серверную квоту. Приватный органайзер привязан к текущему пользователю.
- Форма восстановления требует временный recovery-marker, привязанный к пользователю и сессии. Это клиентская проверка формы; отдельное усиление серверной смены пароля ещё требуется, поскольку Secure password change выключен.
- Email-worker проверяет секрет, канонический адрес Auth и настройки уведомлений, экранирует HTML, ограничивает обработку/частоту и использует таймаут провайдера.

Эти выводы не отменяют отдельно перечисленные ошибки дат, спама, удаления файлов и legacy-контента.

## Секреты и зависимости

В текущих просканированных текстовых файлах и 688 доступных исторических Git-объектах не найдено признаков опубликованных серверных секретов или private key. В реально отдаваемом JS обнаружен publishable Supabase key; server-secret индикаторы отсутствуют.

Publishable key в браузере предусмотрен архитектурой Supabase: защита данных должна обеспечиваться grants, RLS и RPC. Его наличие не является утечкой серверного ключа. [Supabase: API keys](https://supabase.com/docs/guides/getting-started/api-keys).

GET для секретных путей не выдал env/Git; некоторые маршруты возвращают общий SPA HTML. Проверенный source map не был публично выдан. Поиск по шаблонам не гарантирует обнаружение всех видов секретов, не охватывает недоступные репозитории, внешние журналы и старые Vercel env.

Секреты, токены, реальные адреса пользователей и содержимое переписок в отчёт не включены. Каталоги и диагностические материалы хранятся локально в игнорируемой папке и не публиковались.

**Доказательства:** [текущие файлы](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/secret-scan.json), [история Git](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/history-scan.json), [production JS](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/live-bundle-checks.json), [npm audit](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/dependencies.json).

## Границы аудита и незавершённая проверка

Разрешение доступа позволило проверить рабочие настройки и метаданные, но безопасный аудит не равен попытке разрушить production.

Не выполнялись изменение чужого контента, отравление рабочих чатов датами, массовые загрузки, подбор паролей, создание множества пользователей, чтение приватных сообщений, реальная оплата/возврат или восстановление рабочей базы.

Для окончательного допуска остаются:

1. Отдельное окружение с пользователями A/B, ADMIN, editor, старостой, заместителем, участником и Premium — воспроизвести отрицательные и положительные сценарии из SEC-01–18.
2. Проверить IAM внешних сервисов: владельцы/участники Supabase, GitHub и Vercel, 2FA, OAuth apps, access tokens, branch protection, workflow permissions, старые env/preview и shareable links.
3. Проверить полный жизненный цикл платежа и возврата в изолированном режиме, доставку webhook, повтор/порядок событий, журнал и уведомление о сбое.
4. Настроить и реально проверить восстановление БД + Storage вне production.
5. Проверить нагрузку, квоты, текущие ошибки функций, очереди уведомлений и отзыв доступа/сессий при блокировке.
6. Проверить процессы обработки персональных данных, хранения/удаления, поддержки и прав на контент. Юридическое соответствие не сертифицировалось этим техническим аудитом.

## План исправления по сигналу владельца

| Порядок | Работа | Критерий завершения |
| --- | --- | --- |
| 1 | SEC-01–03: владельцы публикаций, колонки, metadata изображений, Storage | Прямые запросы B/anon не меняют объекты A; собственные разрешённые операции работают |
| 2 | SEC-04–05: серверные даты, CHECK, безопасный UI, обработка плохих старых данных | Некорректная запись не создаётся и не ломает чтение |
| 3 | Backup + ADMIN MFA + внешние доступы | Успешное восстановление отдельной копии; privileged действия требуют второй фактор; лишние доступы отозваны |
| 4 | Квоты файлов/сообщений, CAPTCHA, cleanup, headers, авторство/профиль | Лимиты нельзя обойти прямым или параллельным запросом; права и очистка проверены |
| 5 | Совместимое обновление зависимостей, вход/callback, worker и monitoring | Повторный audit, тест входа/оплаты/почты, оповещения и план реагирования |
| 6 | Повторная проверка production после конкретного деплоя | Рабочие политики/функции совпадают с исправлениями; все P1 закрыты; остаточные риски явно приняты |

**Оценку пересчитать после исправлений и повторной проверки.** Предварительный балл 4/10 нельзя автоматически заменить на высокий только после успешного build или нового redeploy.

## Локальные материалы для повторной проверки

- [полный каталог policies public/Storage](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-all-policies.csv)
- [grants таблиц](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-grants.csv) и [grants колонок](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-column-grants.csv)
- [224 функции](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-functions.csv)
- [триггеры и защитные функции; HTTP arguments удалены из локального снимка](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-guards.csv)
- [RLS/колонки/Realtime](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-schema.csv) и [CHECK/FK/UNIQUE](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-constraints.csv)
- [наблюдения панелей и агрегат MFA](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/production-settings.json)
- [безопасные HTTP-наблюдения](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/live-observations.json)
- [результат проверки зависимостей](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/.security-audit.local/dependencies.json)

Снимки относятся к моменту аудита 3 октября 2026 года. Повторный деплой или ручная SQL-правка требуют новой сверки.



