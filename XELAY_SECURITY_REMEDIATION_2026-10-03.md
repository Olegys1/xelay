# Xelay: план применения и проверки исправлений безопасности

**Дата:** 3 октября 2026 года. **Статус:** локальные изменения подготовлены к ревью; в production не применены.

Этот документ дополняет исторический `XELAY_SECURITY_AUDIT_2026-10-03.md`. Исторический аудит не изменён. Его оценка рабочего сайта **4/10 остаётся действующей**: успешные локальные тесты не меняют политики, настройки и файлы рабочего проекта. Новую оценку можно дать после применения изменений, проверки фактической схемы и выполнения операционных пунктов.

Рабочие ориентиры из аудита: `www.xelay.ink`, Vercel `xelay-s-projects / xelay`, Supabase `Xelay mvp / baohfpadxvhqhhjjqtil`. Они нужны для проверки выбранного окружения, а не для автоматического подключения к нему. Не использовать ошибочный Vercel-проект `xelaycompany-glitchs-projects / xelay-knowledge-exchange` как рабочий сайт.

## 1. Что уже подтверждено, что ещё требуется

| Уровень | Состояние |
| --- | --- |
| Локальный код | Подготовлены 004–016: security guards, Auth/MFA, загрузки/cleanup, даты, профили/публикации, question-comment email compatibility, совместимые HTTP-коды отказов Storage и новая пробная неделя учебных групп. Guard-проверки, лимиты и ролевые права не ослаблялись. В staging установлена только цепочка до 015; 016 остаётся локальной. Production не изменён |
| Локальная проверка | Последний фактически завершённый полный **`npm run test:security`: 247/247 PASS, 0 FAIL, 0 SKIP**, включая build; duration68327.8823ms. `lint:types` — exit0; `git diff --check` — exit0, только CRLF warnings. Evidence — ignored `final-security-tests-with-trial-compatibility.log`. Прогон включает 016, parser доступа и expiry-race комментариев. Исторические 199/199 до trial и прежние119/119,186/186 не используются как текущий итог. Локальные проверки не заменяют hosted HTTP evidence |
| Зависимости | Последний локальный `npm audit --omit=dev`: 0 уязвимостей; полный audit: 9 high в цепочках инструментов сборки, связанных с одним оставшимся advisory `braces` |
| Новый staging | **Создан пользователем:** `test1`, ref `saufzpryybuawudohhwj`, organization `jhqltvxmwxbgefjnvuzj`, Free / Ireland / Nano. Data API включён; Automatically expose new tables выключено и сохранено. Complete40 + increments 011–015 успешны: **manifest45**, SHA-256 миграции015 `f79a01ed2fa05a425bb02393e66771831d9f45e6edca670520f9aec7eccebbd0`. Исторический hosted SQL smoke **6 PASS / actual MFA SKIP**, позднее отдельный actual MFA HTTP **9 PASS / 0 FAIL** с полным cleanup. Anonymous HTTPS GET **20/20 PASS**. Production PII и LIVE-ключи не переносились |
| Реальная Storage API | Actual hosted Storage 1.77.5: пять buckets, **84 PASS / 0 FAIL**, cleanup **13 PASS / 0 FAIL**, **97 requests**, file bytes1293 / request bytes14357, pending0. Отдельный direct race: **11 PASS / 0 FAIL**, cleanup **3 PASS / 0 FAIL**,16requests, pending0. История прежних API-ошибок сохранена ниже. Эти scoped checks не подтверждают все races, нагрузку или maintenance worker |
| Human Auth staging | Registration/получение письма, SQL `email_confirmed=true`, обычный вход на ПК и reload подтверждены. Пользователь сообщил о восстановлении и входе с новым паролем; основной агент подтвердил post-recovery UI-профиль. Сам переход callback/consent выполнял пользователь; cross-account mixed tokens и разные устройства ещё не проверены |
| Actual MFA staging | Четвёртый probe `5b133e75-8f28-4f68-833e-354b9d9fe43f`: **9 PASS / 0 FAIL**,17requests, factorRemoved1. Actual AAL1 denial до и после verified собственного фактора и AAL2 allow подтверждены. Raw result pending1 означал ожидающий UI role cleanup; последующая exact UI очистка roleDeleted1 / role absent / roles0 / factors0 / baseline restored закрыла cleanup. История трёх предыдущих attempts сохранена ниже. Production ADMIN enrollment не выполнялся |
| Synthetic Auth sessions | Refresh `b347d58a-2a4d-48a4-bc08-cc0880cbad23`: verified3 / recoveryEvents3 / requests15 / backup2 / canonicalSessionReplaced1 / pending0. Recovery links проверены только в памяти; email, новые пользователи и смена паролей не выполнялись. Это поддержка disposable probes, не notification delivery |
| Рабочая база/сайт | Миграции, деплой, роли, ключи и настройки production в этой фазе не менялись |
| Восстановление | Шифрование, подпись перечня файлов и локальный export проверены на синтетических данных. DB-пароль test1 сохранён владельцем; значение в отчёте отсутствует. Recovery plan подготовлен; Docker installer скачан и проверен, **не установлен**, WSL отсутствует, OS privileges/handoff — следующий gate. Реальный backup/restore БД и Storage ещё не выполнялся |

PGlite-тесты исполняют реальные PostgreSQL функции, RLS, ACL, триггеры и ограничения на синтетическом legacy baseline. Они не заменяют Supabase Auth, Storage HTTP, Realtime, Dashboard-настройки или конкуренцию нескольких соединений. Auth-компоненты проверены с изолированными mocks; полноценного браузерного сценария этим не заявляется.

## 2. Соответствие SEC-01–18

В колонке «локально» указана готовность изменения, а не закрытие проблемы на рабочем сайте.

| Аудит | Локальная мера и файлы | Что подтвердить перед закрытием в production |
| --- | --- | --- |
| SEC-01: чужие вопросы/ответы | **Исправлено в коде, 004.** Запись владельца, неизменяемые автор/ID/системные поля, права колонок; серверные счётчики и допустимые собственные правки сохранены | B не меняет/удаляет публикацию A и не присваивает её; A сохраняет свою правку. Проверить фактические grants/policies и признаки ранее подменённого авторства |
| SEC-02: публичная запись изображений | **Исправлено в коде, 004.** Публичное чтение сохранено; запись привязана к автору родителя и реально принадлежащему ему загруженному файлу; parent/ID неизменяемы | Анонимная запись и B→A запрещены; A добавляет/удаляет файл; существующие изображения читаются |
| SEC-03: перезапись/удаление чужих public-файлов | **Исправлено в коде, 004/008/014.** Ограничительные Storage-политики, действительный owner, личный путь, проверка legacy-путей, caps и reservations; защита уборки по точному объекту/версии. 014 меняет только SQL-коды отказов guard для Storage API | Scoped staging HTTP owner/foreign и direct collision checks прошли. В production повторить B→A upsert/delete/recreate и A avatar replacement; отдельно проверить ownerless и неоднозначные legacy-объекты |
| SEC-04: дата сообщения ломает директ | **Исправлено в коде, 005 + `safeDates`.** Серверная дата, неизменяемость, конечный диапазон, ремонт старых некорректных значений с журналом, безопасный UI | Старые и новые сообщения/tombstone не ломают диалоги; прямой INSERT с опасной датой не обходит нормализацию |
| SEC-05: слишком дальняя дата опроса | **Исправлено в коде, 005 + `safeDates`.** Новый дедлайн ограничен одним годом; слишком опасные старые значения исправляются, исходные метаданные сохраняются в служебном журнале | Poll RPC отклоняет invalid/far-future даты; старые карточки, голосование и срок завершения работают |
| SEC-06: ADMIN без MFA | **Код готов, 007 + `AdminSecurityGate`; scoped actual staging HTTP9/9 PASS.** Требуются ADMIN, JWT AAL2 и собственный verified MFA-фактор. Actual AAL1 denial до/после verified own factor и AAL2 allow подтверждены; временные роль/фактор очищены. UI распознаёт raw ADMIN на AAL1 для enrollment | Оба действующих production администратора должны зарегистрировать и проверить MFA. Включить007 по порядку ниже; отдельно проверить MFA владельцев Supabase/Vercel/GitHub и план восстановления доступа |
| SEC-07: восстановление БД/файлов не подтверждено | **Инструмент готов, пункт открыт.** AES-256-GCM, HMAC manifest, project/host pinning, TLS verify-full, минимальная среда `pg_dump`, явный export | Реальная согласованная полная копия, защищённое внешнее хранение/retention, сохранность passphrase, успешное восстановление БД и Storage в отдельном разрешённом окружении с замером RPO/RTO |
| SEC-08: неожиданная замена сессии ссылкой | **Исправлено в коде.** URL autodetection выключено; очистка адреса, явное согласие с показом email, изолированная проверка refresh credential и совпадения личности до основной сессии | Два браузера/аккаунта: обычный вход, legacy implicit signup/email/recovery и переход между устройствами; смешанные токены не меняют текущий аккаунт; пароль восстанавливается для показанного аккаунта |
| SEC-09: подмена издателя новости | **Исправлено в коде, 006.** Неизменяемые id/published_by/created_at, проверка исходного и нового scope, аудит редакторских изменений | Прямой PATCH и штатный RPC соблюдают те же ограничения; допустимая редактура, pin, scope и права редакторов работают |
| SEC-10: клиентский рейтинг/trust | **Исправлено в коде, 006.** Серверные поля, запрет изменения, отзыв публичных legacy definer RPC/column grants; старые клиенты могут отправить неизменённые значения | Прямые UPDATE/INSERT и все legacy перегрузки не начисляют рейтинг. Проверить исторические показатели отдельно: миграция не сбрасывает существующие оценки и не доказывает их достоверность |
| SEC-11: спам директа/заявок | **Исправлено в коде, 005.** Атомарные лимиты сообщений, заявок, cooldown отклонённой пары, резервирование файлов | Параллельные запросы из нескольких сессий не превышают квоты; уведомления не размножаются; нужен отдельный контроль HTTP/WAF/CAPTCHA и реакции на злоупотребления |
| SEC-12: обход UI-лимитов файлов | **Исправлено для public и chat/direct, 004/005/008/014/015.** Проверки владельца, reservations, квоты/частота/байты, серверные caps вложений; UI вызывает reserve до upload. 014/015 сохраняют guards и нормализуют только коды отказа actual Storage API | Scoped hosted preflight/final upload/denial/cleanup пяти buckets прошли; исчерпание квот, повторные HTTP-загрузки одной lease и нагрузку проверять отдельно. Квоты public и chat/direct раздельные; общий лимит всех news/academic buckets и HTTP-антиабьюз остаются отдельными задачами |
| SEC-13: потерянный приватный файл | **Исправлено в коде, 005/008/009/011/012 и UI.** Cleanup receipts дают узкий доступ owner/actor после отсоединения; проверяется результат remove, есть повторные попытки, service worker, per-bucket cursors и version checks | Scoped staging cleanup и direct tombstone прошли. Worker end-to-end, attach/delete, смена роли и замена physical version требуют оставшихся checks; не удалять attached/new-version объект. Старые signed URLs живут до TTL; немедленный отзыв не обещается |
| SEC-14: лишнее обновление чужого чата при cancel | **Исправлено в коде, 005.** Только собственная pending-заявка; повторная проверка после lock; no-op не меняет чат; частотный лимит | Чужой/несуществующий ID не обновляет чат и не создаёт Realtime-шум; повтор собственной отмены идемпотентен |
| SEC-15: email oracle через профиль | **Исправлено в коде, 006.** Email канонически берётся из Auth, cache синхронизируется сервером; UNIQUE profile cache убран; отправленные клиентом адреса не становятся истинными | Нельзя различить наличие чужого email через свою profile-запись. Проверить подтверждённую смену email и уведомления; их recipient по-прежнему берётся из confirmed Auth |
| SEC-16: публичная legacy `xelay_users` | **Исправлено в коде, 006.** Закрыты клиентские чтение/DML и grants, включая column grants | Фактические ACL/RLS не позволяют чтение перед возможным импортом/backfill. В аудите было 0 строк; текущая утечка не заявлялась |
| SEC-17: браузерные заголовки | **Исправлено в конфигурации.** CSP с hashes фактических inline scripts, `frame-ancestors`, X-Frame-Options, Referrer-Policy, Permissions-Policy, no-store для API | Проверить live заголовки, отсутствие CSP-ошибок и работу Auth redirects, Supabase, checkout/callback/webhook. Это не самостоятельное доказательство отсутствия XSS |
| SEC-18: зависимости/dev server | **Частично закрыто локально.** Обновлены runtime/build пакеты; Vite 8.0.16, PostCSS 8.5.28; dev привязан к 127.0.0.1; runtime audit 0 | Полный audit остаётся 9 high в build/tooling цепочках `braces`; пересмотреть при появлении исправления. Проверить lockfile и сборку конкретного деплоя |

## 3. Пакет миграций и совместимость

| Миграция | Содержание |
| --- | --- |
| `202610030004_legacy_content_storage_security.sql` | Legacy questions/answers/images: RLS, grants, системные поля, текстовые/частотные caps; public Storage owner/caps/квоты/резервирование |
| `202610030005_message_chat_security.sql` | Даты/опросы, директ и заявки, атомарная отправка с вложениями, приватные reservations/квоты, cleanup receipts/claims, семинарная квитанция |
| `202610030006_profile_news_security.sql` | Канонический email, rating/trust, закрытие `xelay_users`, неизменяемый издатель и аудит новостей |
| `202610030007_admin_mfa.sql` | ADMIN-проверка с AAL2 и verified фактором; применять после enrollment действующих администраторов |
| `202610030008_security_public_media_cleanup.sql` | Проверка ссылок на public media, атомарная защита от attach/delete race, service claims, ограниченный scan cursor и maintenance |
| `202610030009_security_maintenance.sql` | Сохранённая в БД очередь round robin: service-only `xelay_media_cleanup_next_scope()` переключает приоритет private/public |
| `202610030010_question_comment_notifications.sql` | Совместимость обычных question comments с UUID notification references; исправляет существующую ошибку text-to-UUID, сохраняет комментарии для исторических не-UUID IDs; не добавляет открытый клиентский helper |
| `202610030011_media_cleanup_bucket_cursors.sql` | Отдельный cursor каждого public/private bucket, bounded pages и ротация buckets; используется существующий Storage bucket/name index. Установлена отдельно в test1, manifest41 на этом историческом этапе |
| `202610030012_media_cleanup_storage_versions.sql` | Compatibility с actual managed Storage C-collation/indexes/versioning. Increment с source-hash prefix `ea9b809e` установлен в test1: manifest42 на этом этапе. Hosted EXPLAIN всех5scopes использует `idx_objects_null_version`, bucket+cursor IndexCond и no Sort; это estimated plan, не ANALYZE/load proof |
| `202610030013_question_comment_email.sql` | Whitelist queue и generic server template поддерживают `question_comment`. Существующие Auth/preferences/dedup/rate/claim guards сохранены. Только будущие события; без backfill, enable или отправки писем. SQL установлен в test1; реальная delivery ещё не проверена |
| `202610030014_public_storage_error_compatibility.sql` | Четыре Storage guard-отказа: размер, MIME, несовпадение reservation и cap получают SQL42501 вместо22023. Только коды: owner/reservations/locks/leases/лимиты/trigger/policies не меняются. Reserve RPC по-прежнему возвращает22023 для своих validation errors |
| `202610030015_private_storage_error_compatibility.sql` | 13 default P0001 denials в пяти текущих Storage trigger-функциях заменены42501: private upload/update/delete, seminar name invalidation, chat deletion (с article-cover guard). Сохранены актуальные locks, cleanup claims, version checks и attachment rules; обычные RPC P0001 не меняются. Установлена в test1: текущий manifest45, SHA-256 миграции015 указан в разделе1 |
| `202610030016_group_trial.sql` | Локально: новые учебные группы получают ровно168 серверных часов; после срока запись блокируется даже при старом global payment switch=false. Ролевые права, старые лицензии и чтение данных сохранены. Ранний оплаченный год начинается после остатка trial; refund не перезапускает неделю. No backfill, user reset RPC или recurring charge. Offline PostgreSQL/ACL/RLS проверки прошли; в test1 и production ещё не применена |

Исторические миграции не переписывались. Новые миграции 004–015 транзакционные; это не обещание их повторной применимости после успешного COMMIT. Сначала проверить таблицу истории и фактическую схему. После отказа выяснить, был ли COMMIT, и устранить причину; не повторять исторический seed ролей и не создавать дубли вручную. Compatibility corrections применяются новыми миграциями, а не изменением уже установленного SQL. 010 исправила найденную полной legacy parity проверкой совместимость; сама по себе она не подтверждает доставку email.

В [официальном исходнике Supabase Storage `database/errors.ts`](https://github.com/supabase/storage/blob/master/src/storage/database/errors.ts) SQL42501 сопоставляется с AccessDenied; SQL22023 и default P0001 уходят в общий DatabaseError. Это текущий upstream master, не доказательство deployed revision. Совместимость actual Storage1.77.5 подтверждена отдельно повторным hosted runner: до014/015 guard отклонял операцию, но API скрывал причину за500; после них ожидаемые400/403 checks прошли. Exact-body/parity offline tests подтверждают отсутствие других изменений guard.

Текущие права оплаты и учебных групп сохранены: академическое редактирование требует действительного старосту либо accepted/approved заместителя с конкретным разрешением и нужной лицензией. ADMIN сам по себе не получает schedule/homework/seminars/seminar_resources. Доступ к своему обычному профилю и own billing status не требует MFA. Служебные create/apply billing RPC сохраняют service-only доступ без AAL2.

### Пробная неделя: новая локальная версия после hosted-проверок

После пользовательского подтверждения добавлена 016 и новая редакция оферты
`2026-10-03.1`. Новые группы получают168 серверных часов один раз; старая
первая бесплатная акция больше не создаёт новые lifetime-grants. Старые
grants и данные сохранены, backfill отсутствует. Новые trial-группы после
срока read-only независимо от старого `enforce_group_payment=false`.
Права старосты/заместителей, service billing и MFA остаются отдельными guards.

Offline-тесты исполнили создание через approved request, точный срок,
immutability/ACL/RLS, expiry внутри старой транзакции, запреты академических
INSERT/UPDATE/DELETE/uploads и семинарных действий, чтение сохранённых
данных, scoped deputy permissions, повторную заявку/миграцию, год после
остатка trial, renewal/replay/refund/test-mode и сохранение legacy-grants.
UI parser/gate проверен отдельно. Реальный асинхронный handler комментариев
проверен с изолированными setters: license expiry сохраняет snapshot/draft,
membership/auth loss очищает их, fresh billing разрешает запись снова,
запоздавший ответ другого scope не меняет текущий доступ. Это unit checks,
а не React-render или hosted browser/HTTP proof.

Последний полный локальный прогон после этих правок: **247/247 PASS,
0 FAIL,0 SKIP**, включая build; types/diff успешны. Публичный trial-текст
проверен в localhost UI; screenshot — ignored
`group-trial-subscription.jpg`. API оплаты на Vite не выполняется.

**Граница evidence:** test1 всё ещё through015/manifest45. Actual media,
race и MFA evidence выше относятся к этой установленной версии. 016 пока
не применена в облаке. Current complete assembler включает46 sources;
historical MFA operator seed/cleanup намеренно сохраняет строгий45 guard.
Его тест собирает только известную границу015 через `migrationsThrough`,
не ослабляет actual SQL guards. Перед hosted increment016 подготовить
согласованную46 версию operator-процедур и повторить scoped проверки;
не запускать empty-project installer или45 operator поверх46.

Ни hosted trial, ни production rollout, ни повышение рабочей оценки
безопасности по этим локальным результатам не заявляются.

#### Исправление зависимости 016 при ручном запуске в рабочей базе

Пользователь получил `P0001` в начальной проверке старого варианта 016.
Read-only проверка проекта `Xelay mvp` (`baohfpadxvhqhhjjqtil`)
подтвердила: из восьми прежних зависимостей отсутствует только
`xelay_private_guard_storage_delete()`, таблицы `group_trial_entitlements`
нет. Evidence — ignored `group-trial-production-preflight.json` и screenshot.
Ошибка возникла до DDL в транзакции; trial этим запуском не установлена.

Этот маркер появился в 005, но не вызывается ни одной функцией 016.
Неустановленная 016 исправлена: требует реальные функциональные зависимости
до 003, включая столбцы cleanup receipts и включённые триггеры академических
изменений. При отказе перечисляет отсутствующие объекты. Установленные
004–015 не переписываются; тела trial-функций, ACL, роль старосты и разрешения
заместителей от этой правки не меняются. `group_trial_preflight.sql` выполняет
тот же guard в `READ ONLY` транзакции с `ROLLBACK`, без установки trial.
Совместимость отдельной trial-функции не подтверждает готовность общего
security rollout; рабочая оценка безопасности от неё не повышается.

Actual `READ ONLY` preflight с новым guard прошёл в рабочей базе:
`GROUP_TRIAL_PREREQUISITES_OK`, `trial_table_exists=false`; выполнен `ROLLBACK`.
Evidence — ignored `group-trial-production-contract-preflight.json` и `.jpg`.
Это проверка реального prerequisite-контракта, не установка или hosted trial
smoke-test. Промежуточная синтаксическая ошибка редактора при замене текста
диагностики устранена полной очисткой своей вкладки; изменения базы не выполнялись.

Дополнительная offline-матрица `group-trial-compatibility.test.mjs` прошла
**17/17** на схемах `003 + 016` и `015 + 016`: права и срок, академические
CRUD/RPC/Storage-policy отказы после срока, чтение, cleanup, повторная заявка,
750 грн/12 месяцев, ранняя оплата/refund и сохранение старых прав.
`group-trial-preflight.test.mjs` — **2/2**: guard точно совпадает с миграцией,
read-only запуск на 003 не устанавливает trial. Итоговый полный прогон
**247/247 PASS, 0 FAIL, 0 SKIP**, build включён; types и diff — exit0.
Evidence — ignored `final-security-tests-with-trial-compatibility.log`.
Storage-проверки этой матрицы исполняют SQL policies в локальном PostgreSQL;
это не новый hosted Storage HTTP прогон.

### Точные ограничения новых записей

| Объект | Серверный предел |
| --- | --- |
| Questions/answers, общая частота автора | 30 новых публикаций за минуту, 1000 за 24 часа |
| Question title / content / category | 500 / 50 000 / 200 символов; существующие длинные поля сохраняются, caps проверяют INSERT/изменение поля |
| Public media URLs внутри контента | Не более 100 ссылок на файлы платформы |
| Public вложения публикации | Не более 5 файлов, суммарно 50 MiB |
| Avatar | 5 MiB; JPEG/PNG/WebP/GIF/AVIF |
| `question-images` | 25 MiB; те же raster MIME |
| `answer-media` | 25 MiB; raster MIME и MP4/WebM/QuickTime |
| Public media, на пользователя в трёх buckets | 500 объектов и 500 MiB с учётом активных reservations; 50 reservations/час и 200/24 часа; lease 15 минут |
| Direct messages | 30/минуту на автора и диалог, 1000/сутки на автора; создание дат серверное |
| Connection requests | 10 за 10 минут, 30/сутки; после rejected той же направленной пары — cooldown 1 сутки |
| Cancel chat request | 10 за 10 минут, 50/сутки; только собственная pending-заявка |
| Direct attachments | Не более 5, максимум 25 MiB на файл и 50 MiB на сообщение |
| `xelay-message-media` + `xelay-chat-media`, общий пул пользователя | 1000 объектов / 1 GiB, до 100 detached/pending вместе с reservations; 30 reservations/минуту и 200/сутки; одна reservation удерживает максимальные 25 MiB |
| Новый дедлайн poll | Конечная будущая дата не дальше одного года |

MIME/байты проверяются по данным Storage и разрешённой загрузке; это не антивирус и не полная проверка содержимого файла. Reservations ограничивают допустимые операции и объём, но повторные HTTP-попытки по той же активной lease требуют отдельного ограничения на границе сервиса.

## 4. Новый staging: подготовка

**Вход восстановлен; новый проект создан пользователем:** `test1` / `saufzpryybuawudohhwj` в organization `jhqltvxmwxbgefjnvuzj`, Free / Ireland / Nano. Его появление подтверждено в Dashboard. Ранее подготовленная агентом форма «Xelay security staging» не создала проект: пользователь использовал другую форму и создал `test1`. Production `baohfpadxvhqhhjjqtil` не изменён.

Подтверждено до установки в read-only UI: PostgreSQL `17.11.0.002`, Auth `2.197.0`, PostgREST `14.18`, регион `eu-west-1`, три существующих владельца organization; 0 public tables, 0 Auth users, 0 Storage objects и 0 buckets. Data API включён, показаны два exposed schemas и max rows 1000. Опция **Automatically expose new tables** первоначально была включена; выключена и сохранена через UI, evidence — `.security-audit.local/staging-api-isolation.jpg`. Read-only schema snapshot сохранён основным агентом в `.security-audit.local/staging-schema-before.json`: `pgcrypto 1.3` и `uuid-ossp 1.1` установлены, `pg_net` / `net.http_post` отсутствуют; repository migrations поддерживают этот случай условно. SQL-role `postgres` не superuser, имеет RLS bypass; у `supabase_storage_admin` RLS bypass нет. Managed Storage protection triggers присутствуют: их нельзя отключать ради smoke-test.

**История hosted установки на 2026-10-03:** первая попытка complete installer завершилась42501 на необязательном CREATE INDEX managed `storage.objects`; полный rollback отдельно проверен — public/Auth/Storage/buckets counts0 и installation manifest отсутствует. В008 создание дополнительного scan index стало условным при недостаточных правах; обязательные ACL, leases, bounded candidates и guards не отключались. Повторный complete installer завершился успешно, UI показал **40 installed sources**; post-010 bundle имел **872 057 bytes**. Затем011 установлена отдельным increment: manifest41, evidence `.security-audit.local/staging-install-through011.jpg`. 012 с source-hash prefix `ea9b809e` дала manifest42 и совместимый EXPLAIN. После описанной ниже HTTP-диагностики013–015 установлены только в test1: **текущий manifest45**, SHA-256 миграции015 `f79a01ed2fa05a425bb02393e66771831d9f45e6edca670520f9aec7eccebbd0`. Это не production установка или activation worker. Точная отметка SQL COMMIT из server log не извлекалась, поэтому время события не выдумывается.

Пользователь подтвердил сохранение ровно двух Auth Redirect URLs: `http://localhost:3000/auth/callback` и `http://localhost:3000/reset-password`. Подготовлен ignored local mode file с public/publishable connection только к `test1`, запущен local dev frontend в режиме `security-staging` на `http://localhost:3000`; LIVE-ключи не используются, значения connection key не сохраняются в runbook. **Human basic Auth checks выполнены:** signup UI показал confirmation panel/participant1; получение письма сообщил пользователь, read-only SQL подтвердил **email_confirmed=true**. Сначала phone-localhost не открывался, поскольку frontend работает на ПК; затем обычный вход на ПК и сохранение сессии после reload подтверждены. Пользователь сообщил «восстановил» и «вошёл с новым паролем»; основной агент проверил post-recovery UI-профиль «Тест». Evidence: `.security-audit.local/test1-human-auth-observation.json`, `test1-restored-login-verified.jpg`. Это закрывает staging basic registration/mail/signin/reload/password-recovery/new-password-login. Сам callback/consent переход выполнял пользователь и отдельно root не наблюдал; cross-account mixed tokens, legacy callback переходы и different-device compatibility ещё не проверены. Token-bearing ссылки/fragments, пароли и OTP не пересылать в чат.

**Исторический hosted SQL smoke evidence:** `.security-audit.local/staging-smoke-hosted.json` и screenshot `staging-smoke-hosted.jpg` содержат **PASS** для `content_owner`, `profile_system_fields`, `direct_atomic_attachments`, `academic_permissions`, `billing_service`, `admin_mfa_negative`; `admin_mfa_actual_factor` был **SKIP**, поскольку enrolled пользователь на этом этапе не был подготовлен. JSON обозначает evidence как `SQL DB role/JWT simulation; not Auth/Storage/provider HTTP`. Follow-up SELECT после ROLLBACK подтвердил **profiles0 / auth.users0 / storage.objects0**, installation manifest40 — до последующего signup. Smoke использовал synthetic транзакционные fixtures и dummy Storage metadata, не физические файлы, login/challenge или провайдер оплаты. Позднейший actual Auth MFA HTTP9/9 PASS описан отдельно ниже; исторический SQL результат и его SKIP не переписываются.

**Actual anonymous HTTPS evidence:** `.security-audit.local/staging-anonymous-hosted.json` — **20/20 PASS**, 20 requests, 0 failures / hiddenEndpoints0 / pending0 в runner. Только read-only GET с test1 publishable key, без user session/service key. Шесть public-positive проверок вернули HTTP200: Auth settings, question categories, universities, faculties, programs, public profile contract. Четырнадцать closed checks вернули **HTTP401 / PostgreSQL code42501**: profile email, `xelay_users`, conversations/messages, chat metadata/messages, upload reservations, cleanup claims, billing orders/entitlements и cleanup cursors. Проверенный anonymous surface не раскрывает эти private/internal contracts; это не доказательство всех возможных endpoint paths, authenticated IDOR или Storage mutations. Первоначальный sandbox NETWORK failure не дал security evidence; подтверждён только разрешённый повторный escalated read-only run, завершившийся PASS за 2.66 секунды.

**Actual hosted index-plan evidence:** `.security-audit.local/staging-storage-index-plan.json` сохраняет metadata **8 managed indexes / 10 plans**. Для всех пяти cleanup scopes после012 план — **Limit → Index Scan `idx_objects_null_version`**, IndexCond содержит `bucket_id` и `name COLLATE "C" > cursor`, без Sort. Сравнение011: Limit → Sort → Index Scan с bucket-only IndexCond и name filter. Подтверждена совместимость выражения cursor с выбранным managed index; это **estimated EXPLAIN без ANALYZE**, не измерение scanned rows, времени/IO или физически bounded работы на высокой нагрузке. SQL plan не доказывает race safety/фактическое удаление blob.

**Историческая Storage HTTP диагностика — прежние failures сохранены:** первый runner дал **43 PASS / 1 FAIL**, cleanup **4 PASS / 3 FAIL**,51requests/817bytes. Read-only `.security-audit.local/staging-media-failure-snapshot.json` показал objectsA=[]: invalid size-mismatch файл не persisted, metadata трёх normal uploads удалена; reservation68bytes осталась. Named повтор до014 дал **43 PASS / 1 FAIL**, cleanup **9 PASS / 0 FAIL**; `.security-audit.local/staging-media-hosted-second.json` зафиксировал size-mismatch HTTP500/hidden SQL22023 и404 для четырёх cleaned paths. Это была несовместимость кода отказа с Storage1.77.5, а не bypass. После014 расширенный прогон дал **50 PASS / 1 FAIL**: unreserved private upload был отклонён SQL P0001, но API вновь вернул500. 014/015 меняют только guard denial codes на42501; обычные reserve/send RPC validation errors, owner/locks/leases/caps не ослаблены. Production и human A не затронуты.

**Последний actual Storage HTTP — PASS:** `.security-audit.local/staging-media-hosted-through015.json`, run `b34baaa7-e647-46ed-b643-105d57c10683`: **5 buckets**, **84 PASS / 0 FAIL**, cleanup **13 PASS / 0 FAIL**, **97 requests**, file bytes1293 / request bytes14357, pending0. Проверены synthetic reservation/upload/finalization/ownership/read/attachment/denial/delete сценарии `avatars`, `question-images`, `answer-media`, `xelay-message-media`, `xelay-chat-media`; ожидаемые400/403 совместимы с actual Storage1.77.5. Cleanup counters/отсутствие pending относятся к ресурсам этого runner, не к всей базе или автоматическому maintenance worker.

**Отдельный actual direct race — PASS:** `.security-audit.local/staging-direct-race-result.json`, probe `a52264fe-2382-4886-8e53-9eea3d8ec835`: **11 PASS / 0 FAIL**, cleanup **3 PASS / 0 FAIL**,16requests, pending0. Из конкурирующих запросов A один победил; второй получил409/23505 без overwrite. B получил42501, C не увидел private resource, tombstone проверен. Это фактическая многосессионная collision/tombstone проверка, не доказательство всех quota, attach/delete, role-revocation или physical-version races и не нагрузочный тест.

**Actual MFA — история attempts сохранена:** сначала read-only preflight сделал один HTTP-запрос и остановился на отсутствии service права `user_roles`; blanket service grant не добавлялся. После разрешённого temporary ADMIN только exact owned synthetic A первый actual probe дал **3 PASS / 1 FAIL**, `MFA_RESPONSE_INVALID`, **12requests**, factorsRemoved1. `.security-audit.local/staging-mfa-first-result.json` сохраняет failure. Причина первого response FAIL остаётся **неподтверждённой**: QR size не объявляется доказанной причиной. Немедленная approved SQL очистка `.security-audit.local/test1-mfa-role-cleanup-2f6cb1ca-3bff-4381-b680-0d8cc5cf700d.json` подтвердила exactRoleAbsent=true / initialRoleBaselineRestored=true / remainingExactMfaFactors0 / roles0.

В response harness на промежуточном этапе successful enroll получил cap262144bytes; остальные ответы —65536bytes. Focused offline checks этой редакции дали18PASS. Второй actual probe `5a648dfd-0010-4aba-b686-d84bf0c6b5a8` остановился локально: **checksPassed0 / checksFailed1 / requests0 / MFA_LOCAL_IO_FAILED**. Numeric offline preflight показал отрицательное remaining время A/B/C tokens: сессии **истекли**. Это причина блокировки второго запуска, не QR-причина первого. Approved UI cleanup `.security-audit.local/test1-mfa-role-cleanup-5a648dfd-0010-4aba-b686-d84bf0c6b5a8.json` дал roleDeleted1 / exactRoleAbsent=true / initialRoleBaselineRestored=true / remainingOwnRoles0 / remainingExactMfaFactors0.

**Synthetic session refresh выполнен отдельно:** `.security-audit.local/test1-session-refresh-b347d58a-2a4d-48a4-bc08-cc0880cbad23.json`: verified3 / recoveryEvents3 / requests15 / backup2 / canonicalSessionReplaced1 / pending0. Verified recovery links находились только в памяти. Email не отправлялся, новые Auth users не создавались, пароли не менялись. Durable backups и замена canonical session относятся к локальному disposable session context, **не к полной backup БД/Storage или SEC-07**. Credentials и link payload в runbook не сохраняются.

Третий actual probe `cc2e74c9-3bfe-40ae-8269-68319ee7eefb` дал **3 PASS / 1 FAIL**,12requests: successful enroll HTTP200 response был прерван при observed278528bytes из-за cap256KiB. На этой попытке предел ответа — подтверждённая причина; она не переносится задним числом на первый failure. FactorRemoved1 и exact role cleanup подтверждены, evidence `.security-audit.local/test1-mfa-probe-cc2e74c9-3bfe-40ae-8269-68319ee7eefb.json` и `test1-mfa-role-cleanup-cc2e74c9-3bfe-40ae-8269-68319ee7eefb.json`.

**Четвёртый actual MFA probe — PASS и cleanup complete:** `.security-audit.local/test1-mfa-probe-5b133e75-8f28-4f68-833e-354b9d9fe43f.json`: **9 PASS / 0 FAIL**, **17requests**, factorRemoved1. Точная temporary role `af6c803c-f959-40b9-b2cc-cf903e834453` была granted `2026-10-03T18:34:05.327816+00:00` только synthetic A. Actual successful enroll дал **HTTP200 / 577091bytes**; cap теперь **1048576bytes только для successful POST `/auth/v1/factors`**, остальные ответы —65536bytes. Diagnostics безопасно сохраняют phase/status/bytes без QR, tokens или secret. Проверены **AAL1 denial до enrollment и после verified собственного фактора, AAL2 allow**. Raw summary pending1 / uiRoleAwaitingDelete1 означал ещё не удалённую временную роль, а не завершённую очистку. Последующий exact UI cleanup `.security-audit.local/test1-mfa-role-cleanup-5b133e75-8f28-4f68-833e-354b9d9fe43f.json` дал **roleDeleted1 / exactRoleAbsent=true / remainingOwnRoles0 / remainingExactMfaFactors0 / initialRoleBaselineRestored=true**: overall cleanup complete. Production roles/settings не изменялись. Этот scoped API proof не заменяет enrollment двух действующих production ADMIN, frontend gate/cross-account browser matrix или MFA внешних владельцев.

1. **Не создавать дубликат и не выбирать существующий production:** использовать новый `test1`. Перед каждым SQL/настройкой сверять ref `saufzpryybuawudohhwj` в Dashboard. Проверить готовность проекта, managed Auth/Storage, текущие policies/default grants, email/redirect/notification настройки и отсутствие LIVE-конфигурации. Создание само по себе не доказывает безопасность или правильность этих настроек.
2. Пароль БД при создании **вводит владелец вручную в интерфейсе**. Агент не запрашивает его в чате, не вводит через browser API, не копирует и не сохраняет значение. Этот handoff остаётся правилом для любой будущей формы создания или смены пароля; для созданного `test1` повторный ввод сейчас не требуется.
3. Использовать только вымышленные тестовые профили и файлы, адреса контролируемых тестовых почтовых ящиков. **Без production PII, существующих пользовательских аккаунтов и LIVE-ключей.** Пользователь отдельно разрешил registration/recovery email нового `test1` на `oslikoleg5@gmail.com`; это разрешение не распространяется на другие адреса, aliases, приглашения в organization или production рассылку.
4. Подготовить отдельный локальный или Vercel Preview frontend, который явно указывает на новый project ref. Не менять рабочие domains/env. В Preview не должно быть production service-role, merchant secret, notification/maintenance secrets.
5. Оплату держать выключенной: `BILLING_MODE=disabled`, `BILLING_CHECKOUT_ENABLED=false`, `WAYFORPAY_LIVE_APPROVED=false`. Настоящий merchant/live callbacks не переносить. Для отдельного будущего provider test требуется изолированный test merchant и его test-конфигурация.
6. Notification-worker выключить: `NOTIFICATION_EMAIL_ENABLED=false`; не импортировать production webhook secrets, HTTP trigger arguments и внешние адреса отправки. Auth signup/recovery настроить на контролируемую тестовую почту и точные staging redirect URLs.
7. Новый Supabase уже имеет управляемые `auth` и `storage`. **Исторические миграции не содержат полного исходного создания legacy `profiles/questions/answers/...`.** Одни миграции на пустом проекте недостаточны. Подготовлены **STAGING ONLY** `supabase/setup/security_staging_legacy_baseline.sql` и `security_staging_legacy_parity.sql`: второй файл добавляет восемь отсутствовавших legacy таблиц и воспроизводит безопасные foundation columns/constraints/indexes по свежим metadata 15 таблиц. Полный parity проверен локально. Он не копирует пользовательские данные, substitute auth/storage, production HTTP/webhooks/секретные аргументы или старые открытые mutation policies; не выдаёт blanket/default grants. Это bootstrap для тестов, не точный production schema backup. `scripts/security/legacy-fixture.json` остаётся очищенным источником для fixture, а не самостоятельным SQL для SQL Editor.
8. Допустимый альтернативный источник baseline — проверенный schema-only export рабочего проекта. Не переносить строки пользователей, секретные HTTP-trigger аргументы, live hooks или среды. Не создавать заново управляемые Supabase schemas/roles по PGlite fixture. Удалённый schema export/импорт в этой задаче не выполнялся.
9. Подготовить synthetic тестовую матрицу: два platform ADMIN, редактор одного факультета, действительный староста, accepted заместитель только со schedule, ordinary accepted member, pending member, два участника директа и посторонний пользователь. Все UUID должны быть тестовыми. Создавать аккаунты/профили/appointments после установки соответствующей схемы и registration triggers, а не до baseline.
10. **Перед полной цепочкой миграций** использовать полную проверку `createFixture({ useStagingParity: true })`: она включает минимальный baseline и parity supplement без прежних permissive legacy policies и искусственных blanket default grants. Порядок hosted установки: baseline → parity → **все** repository migrations в порядке filename. Для каждого setup-файла оператор явно выполняет `SET xelay.security_staging = 'true';` перед его содержимым в том же SQL-запуске; baseline сбрасывает этот флаг, поэтому supplement требует повторного SET. Setup-файлы отказывают при несовместимом/непустом baseline и известном production ref, если он доступен в URL-настройках. Guards не заменяют ручную сверку target. Не применять setup к production или уже установленной базе.
11. `node scripts/security/build-staging-install.mjs --complete` собирает baseline + parity + filename-ordered migrations в **одну внешнюю транзакцию**, сохраняет SHA-256 source manifest в закрытой `xelay_staging.installation` и запрашивает schema reload. Initial complete installer **40 sources / 872 057 bytes** после patch008 успешно выполнен только в test1; increments011–015 дали **текущий manifest45**. Не применять empty-project installer повторно и не выполнять baseline поверх существующих таблиц; для будущего increment сверять окончательный source hash и предыдущий manifest. Последний local full suite **247/247 PASS,0FAIL,0SKIP,build включён** не заменяет hosted evidence. Scoped hosted DB/anonymous/Auth/media/race/MFA checks описаны выше; worker/load/оставшиеся races и SEC-07 ещё открыты. Synthetic007 actual HTTP проверен; production rollout требует отложить007 до enrollment двух действующих ADMIN.

Для schema-only снимка подготовлен `supabase/setup/security_staging_schema_snapshot.sql`: один SELECT возвращает один JSON result set для SQL Editor → Export → Copy JSON. Он читает только версии/структуру/ACL/extensions/hooks metadata, не печатает function bodies, trigger arguments, секретные URL или пользовательские записи. Его pre-install hosted result уже сохранён в `staging-schema-before.json`; после installation нужен второй снимок. Вариант `security_staging_schema_preflight.sql` выдаёт несколько result sets внутри READ ONLY + ROLLBACK и подходит для клиента, сохраняющего все результаты. Локальные проверки SQL/редакции секретных полей входят в `scripts/security/staging-sql.test.mjs` — **3/3 PASS на full parity**. Нужный target оператор сверяет в Dashboard: NULL project/API setting в SQL не подтверждает изоляцию или exposed schemas в Dashboard.

### 4.1. Следующий практический прогон: Auth, SQL и Storage

1. **Hosted installer through015 подтверждён: manifest45.** Anonymous read-only20/20, estimated index plans5scopes, actual media84/84, direct race11/11 и actual MFA9/9 с exact cleanup прошли. Сверить post-install schema/RLS/ACL snapshot и exposed `xelay_staging`; завершить worker/version-race/load checks до activation. Для staging frontend нужны origin `http://localhost:3000` и `/auth/callback`, `/reset-password`: эти exact Redirect URLs сохранены. Приложение строит redirect из текущего origin, поэтому другая dev-port/Preview URL требует отдельного согласованного allowlist. Basic recovery/new-password-login подтверждён, но full callback/cross-device matrix этим не доказана. [Официальные Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls).
2. **До первого письма проверить SMTP и адрес.** Built-in Supabase SMTP отправляет только точным адресам членов project organization; на 2026-10-03 официальный предел — **2 письма/час на весь проект**, без SLA. Plus aliases автоматически не становятся разрешёнными адресами. Подтвердить, что разрешённый `oslikoleg5@gmail.com` входит в team либо для нового test1 отдельно настроен test SMTP; не добавлять владельцев organization ради обхода ограничения. [SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits).
3. **Human basic Auth завершён в staging:** signup, получение письма, SQL `email_confirmed=true`, обычный вход на ПК/reload и recovery/new-password-login подтверждены с указанным выше разделением human report и UI observation. Сам consent/callback transition не был отдельно root наблюдён; следующий отдельный сценарий — mixed-account/legacy-link/cross-device matrix. Пароль, OTP, TOTP secret и email-link credentials вводит/использует пользователь, агент их не получает. Confirmation/recovery localhost открывать на том ПК, где работает frontend; не пересылать token-bearing URL/fragments. Перед любым будущим resend проверить UI и SMTP budget. Signup + recovery обычно расходуют built-in SMTP бюджет; UI cooldown60sec не заменяет часовой предел.
4. **Три disposable Auth UUID созданы и проверены actual HTTP.** Прогон creator `7a7bba48` только в `test1`: **3 created / 3 verified / 9 requests**; email не отправлялся, human A не изменялся. Использован существующий **test1-only server key**, без production доступа/данных. Программное `auth.admin.createUser` с вымышленными недоставляемыми test адресами, auto-confirm и отдельными генерируемыми credentials не отправляет invite; credentials только в изолированном ignored локальном server context, не `VITE_` и не evidence. Перед media runner нужны готовые синтетические profiles/resources, email preferences OFF и краткоживущие сессии трёх разных UUID. Creator execution подтверждает disposable Auth fixtures, **не email delivery, signup UI, MFA enrollment, Storage upload или чужой resource denial**. Human A сохраняется отдельным аккаунтом: его пароль/OTP/TOTP вводит пользователь вручную. Administrative auto-confirm поддерживается [официальным createUser](https://supabase.com/docs/reference/javascript/auth-admin-createuser). Dashboard Create user остаётся альтернативой с ручным password handoff, не Invite.
5. **Scoped actual MFA завершён: четвёртый probe9PASS/0FAIL,17requests, exact cleanup complete.** AAL1 denial до/после verified own factor и AAL2 allow подтверждены; temporary own role/factor отсутствуют, baseline восстановлен. История first unknown response FAIL / second expired sessions / third confirmed256KiB cutoff сохранена выше. Current cap1MiB применяется только к successful POST Auth factors, остальные ответы64KiB; actual successful response577091bytes. Перед будущими probes нужны expiry/identity checks и согласованный exact synthetic UUID, без blanket service grants. Human пароль/QR/OTP остаются ручными, credentials не печатаются; fake verified factor не вставлять. Следующие production gates — оба действующих ADMIN enrollment/recovery и browser gate/cross-account matrix, не повторная выдача synthetic роли без нужды. [Официальный TOTP flow](https://supabase.com/docs/guides/auth/auth-mfa/totp).
6. **SQL DB smoke отдельно от HTTP — hosted выполнен.** `supabase/setup/security_staging_smoke_rollback.sql` дал6групп PASS в test1; follow-up подтвердил отсутствие fixtures после ROLLBACK и manifest40 на том историческом этапе. Проверены foreign content/system fields, direct atomic attachments, scoped deputy + license и service-only annual/participant billing/replay/refund. Positive actual-factor SQL case остался в этом artifact SKIP; позднейший actual Auth HTTP MFA9/9 — отдельное evidence. Не выдавать повторно очищенную роль ради переписывания старого результата. Fake JWT claims проверяют DB правила, не Auth подпись/challenge. Storage — dummy metadata INSERT внутри rollback, без физического файла/DELETE. Managed protection не отключать; при SQL error выполнить ROLLBACK той же сессии, никогда COMMIT. Неизвестные outbound hooks проверить отдельно: SQL rollback не отменяет внешние side effects.
7. **Последний hosted media runner и отдельный direct race — PASS:**84/84 +cleanup13/13 в пяти buckets и11/11 +cleanup3/3 в race; оба pending0. Historical failures и точные artifacts выше сохранены. `scripts/security/hosted-media-checks.mjs` без `--execute` не делает network requests; принимает только test1 origin, publishable/anon key и три разные краткоживущие A/B/C user sessions, A+B conversation и private chat (C не member); service keys/passwords и production ref запрещены. Tokens только в согласованном ignored context, не evidence/чате/commits. Будущие проверки должны сохранять bounded synthetic scope и cleanup; не ослаблять guards ради HTTP status. Оставшиеся gates: maintenance worker end-to-end, attach/delete/physical-version/revocation/quota races и нагрузка; SQL simulation и estimated plans этого не заменяют.

Этот прогон не закрывает SEC-07: реальная полная согласованная backup-копия и восстановление database + физических Storage файлов с проверкой RPO/RTO всё ещё не выполнены.

### 4.2. Notification worker: проверка конфигурации и безопасный план доставки

Проверены repository code/docs: `server/notificationEmail.ts`, `api/notifications/email.ts`, `api/notifications/retry.ts`, migrations `202610010004_email_notifications.sql`/013, setup `notification_email_retry.sql`, frontend Header и Vite config. Дополнительно выполнено read-only наблюдение **названий** env правильного Vercel-проекта `xelay-s-projects / xelay`: среди16keys отсутствуют `NOTIFICATION_EMAIL_ENABLED`, `NOTIFICATION_WEBHOOK_SECRET`, `XELAY_EMAIL_FROM`; `RESEND_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, `XELAY_PUBLIC_URL` присутствуют. Evidence — `.security-audit.local/production-notification-environment-observation.json`. Значения закрыты и не читались, конфигурация не менялась, deployed runtime/revision не подтверждены. Это конкретный configuration blocker видимого проекта, не доказательство точной причины всех исторических503 или универсального outage. Supabase Auth signup/recovery SMTP и **Resend API notification worker — разные пути доставки**: успешный Auth email не доказывает работу notification worker.

**Что уже есть в коде:** POST `/api/notifications/email` обрабатывает один точный outbox job UUID из INSERT webhook payload; POST `/api/notifications/retry` берёт до пяти due jobs с временным budget. Оба требуют отдельный `Authorization: Bearer` worker secret и возвращают no-store ответы. Queue в БД, claim lock2min/5attempts, повторная проверка preferences/read state и verified canonical Auth email, generic templates без текста private сообщений, provider idempotency key на job — реализованы. `/api` handlers исполняются Vercel runtime; обычный Vite dev на localhost3000 их не поднимает. GET405 означает неподдерживаемый метод, не неисправность POST worker.

| Server setting / dependency | Обязательное условие для отдельного staging worker |
| --- | --- |
| `NOTIFICATION_WEBHOOK_SECRET` | Отдельный случайный secret минимум32 символа без whitespace; одинаковый у отправителя запроса и server handler, не publishable/service key |
| `NOTIFICATION_EMAIL_ENABLED` | Строго `true` только в согласованном коротком controlled-delivery окне; в остальных staging/prod средах оставить прежнее значение |
| `SUPABASE_URL` | Только `https://saufzpryybuawudohhwj.supabase.co`, заранее сверить target; код сам не pinning-ограничивает ref |
| `SUPABASE_SERVICE_ROLE_KEY` / fallback `SUPABASE_SERVICE_ROLE` | Test1-only server credential, не public key; передать только изолированному backend, не browser/Vite |
| `RESEND_API_KEY` | Отдельный разрешённый sending key; владелец вводит/устанавливает приватно, значение не читать и не сохранять в отчёте |
| `XELAY_EMAIL_FROM` | Точный формат `Xelay <address@domain>`; sender/domain должны быть разрешены Resend |
| `XELAY_PUBLIC_URL` | HTTPS root origin без path/query/hash/credentials; это origin CTA/settings в письме. `http://localhost:3000` отвергается. Для теста нужен отдельный HTTPS staging frontend, без ссылок на production |
| Автоматическая доставка | Database webhook INSERT на `notification_email_outbox` и retry schedule **не создаются обычной migration**. `pg_net` сейчас отсутствует в test1; первое ручное one-job POST их не требует |

В текущем handler **GET возвращает405 до проверки config**; исторический503 без метода/revision нельзя приписывать GET этому коду. При корректном worker secret конфигурационная503 возвращает только `configuration_errors` с именами missing/invalid settings. Unauthorized POST при отсутствующем/коротком configured secret даёт generic503 до проверки остальных settings; неправильный предоставленный bearer при настроенном secret —401. Это согласуется с invalid-secret blocker, но не доказывает historical runtime состояние. `200` с `processed:false`, `pending` или `failed` не означает доставку. `sent` означает принятие Resend, не Inbox/прочтение. Provider retry удерживает тот же idempotency key; TTL24h поддержан provider, worker прекращает попытки через23h. [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).

**Question-comment gap исправлен локально, SQL установлен только в test1:**013 добавила `question_comment` в queue whitelist, `server/notificationEmail.ts` — generic template. Сохранены canonical confirmed Auth recipient, preferences/read filters, dedup/rate/claim guards; focused offline tests прошли. Только будущие события: ни backfill, ни enable, ни cloud email send этим изменением не выполнены. Реальная доставка template ещё открыта. Templates `comment`, `answer_comment`, `discussion` по-прежнему не входят в queue whitelist; это отдельные producer contracts, их массовое включение не выполнялось. Первый controlled smoke можно провести с поддержанным `connection_request`/`answer` либо новым `question_comment` после server deployment. Настройки `/?notifications=settings` имеют frontend обработчик Header; destinations строятся из фиксированных путей/безопасных IDs, не caller-supplied URL.

**Что основной агент может подготовить сейчас без отправки писем:**

1. Подготовить isolated HTTPS staging backend/frontend deployment к review, exact env-name template и target checklist, без production env/DNS и без секретных значений. Worker default OFF, webhook/cron не создавать. Проверить сборку/handler import и non-network mocks; в текущем поручении это только план, новый deploy не выполнялся.
2. Подготовить redacted outbox status query только для точных synthetic job UUID (`id/status/attempts/created_at/last_error_code`, без recipients/body); подготовить one-job payload `{type:'INSERT',schema:'public',table:'notification_email_outbox',record:{id:'<exact staging job UUID>'}}`. Не использовать `/retry` для первого теста: он может взять другую due задачу.
3. У всех disposable fixtures установить email preferences OFF. Worker принимает любой syntactically valid confirmed Auth address и не содержит recipient allowlist — auto-confirmed `.invalid` fixtures не должны попадать под общий drain. Перед тестом проверить отсутствующие/старые очереди **без** массовой очистки/перевода их статусов и без ресенда historical production jobs.
4. Подготовить generic preview: subject «Новий запит на спілкування — Xelay», тестовый actor, CTA и settings только на согласованный HTTPS staging origin. Адрес и текст события берутся из БД/Auth; body webhook не может подменить их.

**Что требует действий/согласования пользователя:** отдельно разрешить **одно notification test email** на уже согласованный адрес — прежнее разрешение касалось signup/recovery. Владелец Resend должен предоставить staging sending capability через приватные настройки: подтвердить sender/домен либо подтвердить, что разрешённый адрес совпадает с Resend account email для `resend.dev` testing sender. Последний позволяет письма только на account owner's address; другой получатель получает403, пока не verified own domain. [Официальное ограничение testing domain](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain). Если нужен новый домен/DNS/Preview backend, сначала подготовить конкретную конфигурацию и согласовать её; production DNS/ключи не менять. Пользователь получает письмо и сам подтверждает delivery/link/privacy; passwords/OTP/TOTP остаются ручными.

После разрешения: enable только отдельный worker → создать **один** поддержанный synthetic event к confirmed human A с preferences ON → проверить точный outbox job → ручной authorized `/api/notifications/email` с этим UUID → сверить `sent`/provider accepted и реальное получение пользователем. Повторить тот же UUID для проверки `processed:false` без второго письма. Для отрицательной проверки queue event при preferences ON, затем выключить их **до** one-job вызова: worker должен пропустить отправку; event с уже выключенными preferences не создаёт outbox job и проверяет только queue filter. После короткого окна выключить staging worker, оставить fixtures email OFF; никаких webhook/cron массовых drain. Возможные webhook/retry следующие этапы требуют отдельного решения: `pg_net` + `pg_cron` + Vault, INSERT-only webhook, HTTPS worker URL, Vault `xelay_public_url` и matching secret. Setup по умолчанию документирует production URL — не запускать его неизменённым в test1. Webhooks асинхронны и используют pg_net. [Supabase Database Webhooks](https://supabase.com/docs/guides/database/webhooks).

Этот controlled notification test **ещё не выполнен** и не закрывает production исторические26email/365retry/503, глобальное WAF/SMTP monitoring или реальное backup/restore.

До запуска автоматической уборки убедиться, что staged Storage caps и политики существуют и что synthetic retained-файлы переживают worker. Не включать worker на production до backup/restore и hosted-проверок.

## 5. Backup и восстановление: SEC-07 остаётся открытым

Инструмент: `scripts/security/encrypted-backup.mjs`. Он читает БД/Storage и записывает локальную копию; **SQL restore или загрузку в облако сам не выполняет**.

### Возможности и ограничения

- Custom-format dump схем `public`, `auth`, `storage` шифруется потоково AES-256-GCM с scrypt, случайными salt/nonce; объекты также шифруются.
- HMAC manifest использует отдельный salt и purpose. Он связывает project, точный перечень ciphertext/hash, обязательный `database.enc`, уникальность и число Storage-файлов. Подмена/удаление manifest entry больше не даёт успешную проверку.
- Предел сериализованного payload manifest — 4 000 000 символов: инструмент откажет для большего инвентаря и не должен считать его завершённой копией.
- Адрес Supabase должен совпадать с expected project. БД — direct `db.<ref>.supabase.co` либо разрешённый Supabase pooler с точным `postgres.<ref>`, протокол postgres/postgresql.
- `pg_dump` получает минимальную runtime/PG среду; backup passphrase и service key не передаются ему. TLS — `verify-full`, доверенный root certificate задаётся локально при необходимости.
- Создание требует `XELAY_BACKUP_WRITES_QUIESCED=true`. **Это заявление оператора, не автоматическая блокировка записей.** Должны быть реально остановлены пользовательские/служебные записи, upload/delete, cleanup, внешние изменяющие hooks и callbacks либо их безопасная обработка согласована на время копии. Иначе SQL snapshot и последующий offset-paging Storage могут разойтись.
- Verify проверяет криптографию и инвентарь. Оно не проверяет возможность `pg_restore`, внешние расширения, настроенный SMTP/OAuth, все настройки Dashboard или соответствие hosted Storage metadata физическим объектам.

### Переменные и локальные команды

Переменные задаёт оператор в защищённом окружении, без вывода значений, записи в Git, передачи в чат и аргументах командной строки:

| Переменная | Назначение |
| --- | --- |
| `XELAY_BACKUP_EXPECTED_PROJECT` | Ref источника; проверить явно перед подключением |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Только источник копии; хранить как серверные секреты |
| `XELAY_BACKUP_DATABASE_URL` | Direct/session-pooler connection к тому же проекту; не публиковать |
| `XELAY_BACKUP_PASSPHRASE` | Независимая сильная passphrase минимум 20 символов; хранить отдельно от backup и сервисных ключей |
| `XELAY_BACKUP_WRITES_QUIESCED=true` | Ставить только после реальной остановки записей/очистки |
| `XELAY_PG_DUMP` | Необязательный путь к доверенному совместимому `pg_dump` |
| `XELAY_BACKUP_SSL_ROOT_CERT` | Необязательный локальный trust-root; по умолчанию `system`, проверить поддержку установленным libpq |

Сначала выполнить на synthetic staging. Команды ниже являются инструкцией оператору, в этой задаче не исполняются:

```text
node scripts/security/encrypted-backup.mjs create .security-backups.local/staging-20261003
node scripts/security/encrypted-backup.mjs verify .security-backups.local/staging-20261003
node scripts/security/encrypted-backup.mjs export .security-backups.local/staging-20261003 .security-recovery.local/staging-20261003
```

Родительская папка export должна существовать; целевая — **новая**, инструмент откажется от перезаписи. Export сначала проверяет всю копию, затем создаёт `database.dump` и `<sha256>.payload` с исходным JSON locator/metadata первой строкой и bytes после неё. Исходные bucket/object names не превращаются в пути файловой системы. На POSIX выставляются 0700/0600; на Windows дополнительно проверить ACL. Export — **plaintext**: ограничить доступ и безопасно удалить после разрешённого упражнения. Не присылать payload/dump в чат или публичное хранилище.

### Что требуется для успешного восстановления

Практический выбор изолированного target и проверок описан в [SECURITY_RECOVERY_PLAN_2026-10-03.md](C:/Users/oleza/.codex/.chatgpt-projects/g-p-69774e1464188191817a0344a1fda86f/xelay/SECURITY_RECOVERY_PLAN_2026-10-03.md). Локальный Docker installer скачан и проверен, **установка ещё не выполнена**; WSL отсутствует. Следующий gate — согласованные OS privileges и handoff подготовки WSL/Docker; Windows features пока не менялись. Сохранённый владельцем DB-пароль не является backup или доказательством восстановления. Реальные backup create/verify/export/restore и проверки Storage/Auth/RLS в восстановленном target ещё не выполнялись; уже пройденные functional test1 проверки перечислены отдельно выше.

1. Владелец согласует источник, новый изолированный target, доступ, окно записи, RPO/RTO и срок удаления recovery-данных.
2. Функциональный staging выше остаётся synthetic/no-PII. Полная рабочая копия содержит PII, поэтому её восстановление требует отдельно разрешённого закрытого recovery-окружения. Перенос production-данных в functional staging сейчас не разрешён. Sanitized schema с вымышленными строками проверяет метод, но сама по себе не закрывает восстановление полной рабочей копии.
3. Снять реальную согласованную полную копию БД **и каждого Storage bucket**, проверить manifest и внешнюю защищённую копию. Хранить passphrase отдельно; зафиксировать владельца, retention и проверку успешности следующих копий.
4. В новом разрешённом окружении оператор сначала проверяет TOC/зависимости dump и план восстановления управляемых схем, расширений и grants. `pg_restore` не направлять на рабочую connection string. Готовая автоматически безопасная команда restore для production здесь не предоставляется.
5. Восстановить physical bytes и согласовать фактические object IDs/version/owners с DB metadata. SQL restore `storage.objects` и обычный service upload не являются автоматически совместимой последовательностью: uploads создают метаданные/версии, а новые guards требуют owners/reservations. Если нужна временная процедура административного восстановления, применять её только в recovery target и вернуть защиты перед проверкой.
6. Проверить реальные download bytes, public/private доступ, связи профилей/публикаций/новостей/групп/чата, attached и detached файлы, количество и hash объектов, RLS/ACL, Auth и отсутствие исходящих LIVE-webhooks. Зафиксировать время восстановления и допустимую потерю последних изменений.
7. Повторить verify из внешней копии и документировать результат. **До этого SEC-07 не закрыт, restore readiness не заявляется.**

Обычные backup БД Supabase не включают physical Storage bytes; объекты нужно копировать и восстанавливать отдельно. [Supabase: Database Backups](https://supabase.com/docs/guides/platform/backups).

## 6. Hosted staging: обязательные сценарии

Выполнять с synthetic пользователями и вымышленными файлами. В evidence сохранять ожидаемое/фактическое поведение, коды ошибки, размеры/счётчики, версию Storage и дату; без bearer tokens, паролей и PII.

| Проверка | Ожидаемый результат |
| --- | --- |
| A/B/anonymous вопросы, ответы, изображения | Только владелец редактирует; автор/id/системные поля не меняются; anon только читает продуктово публичное |
| Public Storage old/new paths | B не upsert/delete/recreate A; A загружает и меняет своё; неоднозначный ownerless путь не получает произвольного нового владельца |
| Размер/MIME/количество/частота | Запрет сверх серверного cap даже при прямом HTTP; разумная ошибка UI; unchanged старые длинные записи сохраняются |
| Upload reservation | Preflight rollback не отменяет учёт; final upload проверяет настоящий owner/bytes/MIME; expired/no reservation отказывает; cancelled upload не даёт бессрочную квоту |
| Direct send + attachments | Commit атомарный; лишний файл/чужой объект/неверный MIME не оставляет частично опубликованное сообщение |
| Даты/опросы | Infinity/вне диапазона/дальний срок не ломают списки и карточки; Premium/poll permissions/anonymous voter privacy сохранены |
| Конкуренция | Две независимые сессии: quota near-limit, attach-versus-delete, revoke-versus-edit, replacing same path, simultaneous sends/requests |
| Cleanup | Worker claim привязан к текущему id/version/metadata; replace или attach после listing не удаляет retained объект; actor/owner очищает receipt после потери роли; empty remove считается ошибкой |
| Auth links | Нет автоматической URL-подмены; shown email и явно выбранный аккаунт; access A + refresh B отклоняется; signup/recovery/cross-device/старые implicit links работают |
| MFA | ADMIN AAL1 не вызывает privileged RPC; ADMIN AAL2 + own verified factor проходит; revocation блокирует; stale async response не открывает gate другого аккаунта |
| Профиль/новости | Старый save с unchanged rating/trust работает; значения не начисляются; email канонический; publisher immutable; старый/новый scope проверен; `xelay_users` закрыта |
| Учебные группы | Староста и accepted approved deputy имеют только назначенные права; ordinary/pending/ADMIN-alone не меняют академический контент; истёкшая лицензия блокирует запись; timetable и homework recurrence сохранены |
| Billing | Own status обычного пользователя работает; service create/apply без AAL2; 100 UAH/1 **календарный месяц**, 750 UAH/12 месяцев; повторный event не удваивает entitlement; test-mode не даёт live access; refund отзывает доступ |
| Browser headers | Деплой содержит CSP/hashes/iframe/referrer/API cache guards; signup/reset, изображения, Realtime, checkout form и серверные callbacks не сломаны |
| Recovery | Реальная согласованная copy/verify/export и разрешённый isolated restore с DB/Storage checks, а не только crypto round trip |

В upstream Supabase Storage удаление DB metadata внутри транзакции выполняется до удаления физической версии файла. Это поддерживает защиту SQL-trigger/lease перед blob deletion. Проверен [официальный исходник `storage/object.ts`, строки 194–223](https://github.com/supabase/storage/blob/master/src/storage/object.ts#L194-L223). Это **master upstream, а не подтверждение установленной hosted revision**. Actual Storage1.77.5 media/cleanup и отдельный direct collision/tombstone прогон теперь прошли в test1. Другие attach/delete, replacement-version, revocation/quota races, maintenance worker и высокая нагрузка этим не закрыты; они остаются release gates.

## 7. Координированное применение в production

Этот раздел — будущий порядок для владельца. Наличие файла не является выполненным деплоем или разрешением на новые production-операции.

1. Завершить staging и SEC-07; назначить ответственного за применение, monitoring и остановку операций. Сохранить schema/ACL снимок, version/commit, backup identity и проверенный recovery-plan. Пройти read-only preflight `supabase/setup/security_legacy_public_storage_preflight.sql`: owners, legacy MIME/size, длинные тексты. Он выдаёт агрегаты, не персональные строки.
2. Убедиться в правильном Vercel/Supabase проекте. Проверить, что production secrets доступны только production и не попадают во frontend, Preview, repository или отчёты.
3. Назначить короткое согласованное окно для загрузок/отправки. После SQL новые upload reservations и atomic sends нужны клиенту; старая закэшированная версия может получать ошибки. **Нулевая недоступность и отсутствие ошибок старых клиентов не гарантируются.** Пользователям потребуется reload; не обходить отказ временным возвратом broad RLS.
4. После выполнения release gates применить **004 → 005 → 006 → 008 → 009 → 010 → 011 → 012 → 013 → 014 → 015**, отслеживая каждую транзакцию/COMMIT. 010 — UUID notification compatibility;013 — question-comment queue,014/015 — только Storage denial code compatibility. **007 отложить** до следующих шагов. Служебную уборку и email send не запускать. При отказе остановиться и сверить фактическую схему, а не продолжать вслепую.
   Пакет through015 установлен только в staging, **manifest45**; scoped media/cleanup, direct race, actual MFA с очисткой и estimated index plans прошли. Remaining races/load, worker end-to-end, real backup/restore, operational email и production ADMIN enrollment пока открыты. Установка013 сама не активирует письма; server template deploy должен быть согласован с новой queue. Этот runbook не разрешает включать cleanup на старом010-only SQL или bypass guards для старых cached clients.
5. Деплоить проверенный frontend/server/config вместе: public/private reserve перед upload, атомарный direct send, safe date rendering, явное принятие email-ссылки, gated MFA, CSP и worker. Сверить опубликованную версию; выполнить reload/smoke с owner/ordinary/editor/representative synthetic сценариями в согласованном рабочем тесте.
6. Каждый из **двух действующих platform ADMIN** вручную регистрирует TOTP, сохраняет независимый проверенный способ восстановления и выполняет challenge. Проверить aggregate verified factors, собственный `getAuthenticatorAssuranceLevel()` и отсутствие устаревшей сессии. UI должен распознавать ADMIN по своей raw role на AAL1 — не зависеть от уже закрытого AAL2 helper.
7. Только затем применить **007**. Проверить: ADMIN AAL1/без confirmed factor denied; ADMIN AAL2 + own verified factor allowed. Не назначать ADMIN через изменяемый username. Закрыть старые админские сессии по согласованному плану.
8. Сверить новые политики, таблицы/column grants, SECURITY DEFINER search_path/EXECUTE, триггеры и фактические constraints. Проверить posted limits и privilege paths. RLS «включён» не заменяет проверки выражений/ACL.
9. Проверить рабочие browser headers/Auth redirects, обычные profile saves, вопросы/ответы/изображения, учебные группы и billing status. **Платёжные callback/webhook должны оставаться доступными провайдеру и проверять подпись; требование AAL2 не применяется к служебному billing-пути.** Остановка новых checkout не должна блокировать завершение/возврат существующих платежей.
10. Только после доказательства безопасной уборки и возможности recovery настроить отдельный maintenance secret и доверенный запуск worker. Автоматизация/cron в этой задаче не создавались.
11. Проверить operational пункты ниже, сохранить evidence и пересмотреть оценку готовности на основании рабочего состояния. Не объявлять SEC закрытым только по наличию SQL в репозитории.

### Остановка и откат при проблеме

Остановить затронутые новые записи/загрузки/уборку и диагностировать; сохранить callback обработки уже существующих платежей. Восстановление данных выполнять только по проверенному плану и отдельному решению владельца. Возврат прежнего frontend без reserve/send поддержки при новых SQL guards может сохранять ошибки; подготовить совместимый forward fix. **Не откатывать на старые insecure ALL/RLS, публичные definer grants или произвольный owner update.** Не выполнять исторические role seeds повторно как средство ремонта.

## 8. Maintenance worker и эксплуатация

Endpoint: **POST `/api/security/media-cleanup`**, отдельный `Authorization: Bearer <SECURITY_MAINTENANCE_SECRET>`. Secret — случайный, независимый, минимум 32 символа без whitespace; хранить только в серверной среде и доверенном scheduler. Не использовать anon/service key как этот bearer и не вставлять значение в URL, браузер, чат или Git. GET возвращает 405; отсутствующая конфигурация/ошибки закрываются.

- Работает через service RPC и Storage API, не через прямое удаление `storage.objects` как способ удаления physical bytes.
- Предел функции 60 секунд; worker планирует 53 секунды и 8-секундные сетевые timeouts. Выбирает до 20 candidates на scope, обычно старше 24 часов; claim живёт 5 минут и повторно проверяется SQL при DELETE.
- 009 сохраняет приоритет private/public между вызовами. Это устраняет постоянное вытеснение public при долгой private очереди. `attemptedScopes`/`deferredScopes` показывают выполненные/отложенные области; успешный bounded batch не доказывает пустую очередь.
- Actual scope: private **`xelay-message-media` и `xelay-chat-media`**, public **`avatars`, `answer-media`, `question-images`**. Это не универсальная автоматическая уборка `news/homework/seminar/timetable` buckets. Их pending/receipt cleanup и отдельную автоматизацию проектировать отдельно; существующие permissions сохранять.
- Перед schedule выполнить доверенный ручной вызов на synthetic staging; убедиться, что attached и новая версия сохраняются, detached действительно удаляется, ошибки/empty result видны. Затем отдельно согласовать production schedule. Настройка scheduler сейчас не выполнялась.
- **Current activation gates:** chain through015 установлена только в test1, manifest45. Estimated EXPLAIN всех5scopes подтвердил cursor IndexCond без Sort; actual media84/84 +cleanup13/13 и direct race11/11 +cleanup3/3 прошли. Runner cleanup — не проверка HTTP POST maintenance worker. Открыты отдельный worker end-to-end, attach/delete/replacement-version/revocation/quota races, нагрузка и реальный backup/restore. SQL installation, estimated plan и LIMIT не доказывают измеренный bounded scan или полную безопасную эксплуатацию. Автоматический запуск не включать до этих gates и отдельного согласования.
- Мониторить candidates/claimed/removed/skipped/failed, attempted/deferred scopes, Storage count/bytes, rejected reservations, 5xx и возраст очереди. При ошибках lease/upload service не «исправлять» отключением guards.

## 9. Оставшиеся операционные задачи

| Задача | Состояние / действие |
| --- | --- |
| Новый staging `test1` | Chain through015 **manifest45**, SHA-256 миграции015 в разделе1. Исторический DB smoke6PASS/actual-factor SKIP; anonymous20/20PASS. Actual media пяти buckets84PASS/0FAIL +cleanup13/13,97requests,pending0; direct race11PASS/0FAIL +cleanup3/3,16requests,pending0. Basic human registration/mail/PC signin/reload/recovery/new-password-login подтверждены; callback/cross-device browser matrix ещё не завершена. Четвёртый actual MFA9PASS/0FAIL,17requests; subsequent exact role/factor cleanup complete. Первые три attempts сохранены как история. Session refresh verified3/recoveryEvents3/15requests/backup2/replacement1/pending0 безemail/passwordchange/newusers. Index plans — estimated/noANALYZE. Последний fullsuite **247/247 PASS,0FAIL,0SKIP**, build/types/diff успешны; новая016 проверена только локально. Production не менялась |
| MFA действующих ADMIN и внешних владельцев | Enrollment production не выполнен. Проверить двух ADMIN, recovery plan и MFA доступа к Supabase/Vercel/GitHub |
| Backup/restore/retention | Полный рабочий backup, offsite хранение, периодичность, ключевой escrow, retention, RPO/RTO и реальный restore не проверены |
| Hosted Storage / concurrent sessions | Scoped actual Storage1.77.5 upload/read/denial/cleanup пяти buckets и separate direct collision/tombstone прошли. Оставшиеся worker/attach-delete/version/revocation/quota races, ownerless legacy cases и высокая нагрузка не подтверждены |
| Автоматизированный HTTP-абьюз | БД квоты ограничивают операции, но CAPTCHA/WAF, per-IP/tenant budgets, HTTP lease replay и alerts требуют отдельной настройки/проверки |
| News/academic media | Новая общая service-уборка их buckets не включена; существующие private access/role/license checks сохранены |
| Email notification-worker | Исторические26email/365retry/503 остаются операционной проблемой. Read-only список16keys правильного Vercel-проекта не содержит `NOTIFICATION_EMAIL_ENABLED`, `NOTIFICATION_WEBHOOK_SECRET`, `XELAY_EMAIL_FROM`; values/runtime не проверены, ничего не менялось. Это concrete config blocker, не точная причина всех503. Question-comment queue/template исправлены локально;013 SQL test1 установлен. Controlled delivery/Resend/HTTPS worker config и отдельное send permission ещё требуются; Auth mail не доказывает notification delivery |
| Существующие rating/trust/авторство | Оценить накопленные данные отдельно; блокирование будущей записи не восстанавливает автоматически честные прошлые значения |
| Future faculty-admin appointments | Исторический username seed не изменён. Новые назначения делать только по независимо подтверждённому immutable user UUID; не выводить UUID из текущего ника и не повторять seed |
| Sitemap | Локально ограничен 1000 записей, публичным ключом и cache, unsafe date имеет fallback; проверить live route после деплоя |
| Секреты и репозиторий | Ignore расширен для `.env.*`, `.local`, dump/backup; серверные env никогда не имеют `VITE_` prefix. Проверить actual deployment scopes и diff перед публикацией |
| Полные build-зависимости | 9 high в цепочках `braces`; принимать как ограниченный остаточный риск сборочного окружения, не как «всё исправлено» |

По актуальному [GitHub advisory GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), deeply nested brace patterns могут исчерпать стек в `braces <=3.0.3`; patched version пока не указана. В этом репозитории достижимые оставшиеся пути относятся к lint/build tooling; пользовательские сообщения не подаются как build glob. Полный audit считает затронутые пакеты/цепочки, поэтому **9 high не означают 9 независимых эксплуатируемых ошибок production**. Не запускать слепой `npm audit fix --force`, который предлагает несовместимый откат/смену major. Сохранить lockfile, проверять зависимости на trusted build inputs и повторять audit при появлении патча.

## 10. Критерии завершения

Задачу можно считать применённой и пересматривать рабочую оценку, когда:

- новый staging создан и подтверждена изоляция;
- на утверждённом commit/lockfile успешно воспроизводится **полный текущий** `npm run test:security` (он включает build и все `scripts/security/*.test.mjs`), `npm run lint:types` и `git diff --check`; сохранить фактические totals/version/date конкретного прогона без фиксированного устаревающего числа тестов;
- hosted сценарии и многосессионные races проверены;
- выполнена реальная согласованная копия и разрешённый успешный DB/Storage restore;
- применены 004/005/006/008/009/010/011/012/013/014/015, совместимая frontend/server версия, enrollment двух ADMIN и затем007;
- сверены actual policies/grants/functions/triggers/constraints и рабочие заголовки;
- обычные права пользователей, права старосты/заместителя и service billing сохранились;
- безопасная уборка, monitoring и operational email/backups имеют назначенных владельцев;
- остаточные build/HTTP/academic-worker риски явно приняты либо устранены.

До выполнения этих пунктов документ остаётся **локальным готовым к ревью runbook**, production-оценка — **4/10**, SEC-07 — **открыт**. Решение по production launch — **NO-GO** до coordinated rollout и оставшихся release gates; staging PASS сам по себе не меняет рабочий сайт.
