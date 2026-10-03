# План проверки backup/restore test1 — 2026-10-03

**Статус: подготовленный план для выбора и согласования.** Backup и restore ещё не выполнены; успешное полное восстановление не заявляется. Здесь нет разрешения на установку, оплату или облачные изменения.

Источник — только `test1`, ref `saufzpryybuawudohhwj`. Restore никогда не направляется в test1. Production `baohfpadxvhqhhjjqtil` не используется как источник или target и остаётся без изменений. Копия test1 тоже содержит чувствительные Auth данные; dump, payloads, токены и ключи нельзя публиковать.

## 1. Выбор пользователя до установки

| Вариант | Что подготовить | Действие пользователя перед продолжением |
| --- | --- | --- |
| **A — рекомендован: отдельный локальный Supabase stack** | WSL, Docker Desktop с Linux containers, официальный Supabase CLI, отдельная recovery-директория, новые volumes/ports и собственные локальные ключи. PostgreSQL 17, совместимые Auth/Storage версии. Docker installer уже скачан и проверен, но не установлен. | Согласовать установку WSL и Docker. Если нужны Windows features, UAC или reboot, выполнить это отдельно после объяснения фактической необходимости; лицензионные условия подтверждает пользователь. |
| **B — новый изолированный recovery-проект Supabase** | Новый пустой проект, отличный от production/test1, отдельные credentials и согласованные временные ограничения доступа. | Проверить в Dashboard доступный project slot, тариф и стоимость; подтвердить создание именно recovery-проекта. Free-слот и отсутствие расходов не предполагаются. Существующие проекты ради освобождения слота не удалять. |

Supabase CLI запускает локальный Supabase stack через контейнерный runtime. Начать его нужно в новой recovery-директории, без `link` к production/test1 и без применения репозиторных миграций поверх уже восстановленных таблиц. [Официальная инструкция Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started).

Локальный preflight выполнен без изменения Windows features:

| Проверка | Наблюдение |
| --- | --- |
| WSL | `wsl --status` сообщает, что WSL не установлена. |
| Docker / native PostgreSQL | Docker и native PostgreSQL tools/server не обнаружены; найденные DaVinci tools имеют версию 13.4. |
| Windows | Registry build `26200`, display version `25H2`. Старую строку ProductName с Windows10 не использовать как достоверное определение версии. |
| Память / диск | 15.3 GiB RAM; на C: свободно 108.8 GiB в момент проверки. Это не замер требуемого размера recovery stack. |
| Virtualization | `HypervisorPresent=true`, `VirtualizationFirmwareEnabled=true`, `SecondLevelAddressTranslationExtensions=false`. Последний признак может быть скрыт активным гипервизором; по нему одному неподдерживаемость не установлена. |

Перед установкой ещё проверить выбранный WSL/Docker backend и допустимые privileges. Требуемый диск определить по images, database, Storage, encrypted backup, plaintext export и restore volumes с запасом. Docker per-user installation и первоначальная настройка WSL имеют разные требования; необходимость admin/reboot установить по фактическому пути установки. Пользователь самостоятельно подтверждает installer/UAC, изменение Windows features и лицензионные условия. [Docker Desktop на Windows](https://docs.docker.com/desktop/setup/install/windows-install/).

### Проверенный Docker installer

- Официальный Docker Desktop **4.93.0** скачан в `.security-audit.local/tooling/DockerDesktop-4.93.0.exe`.
- Размер: **627791792 bytes**. SHA256: `c139124c9cf71477dc565c3c0ea5a18f90b93d68ebe9aaa848a065960416c0bc`; совпадение с official checksums проверено.
- Authenticode: **Valid**, подписант **Docker Inc.**
- Installer **не установлен**; WSL/features не изменены, EULA не принята, reboot не выполнен. Наличие проверенного файла не означает готовность контейнерного runtime.

**Обычный PostgreSQL сервер или отдельная схема внутри test1 не заменяют полный recovery target:** они не предоставляют работающие Auth/Storage API и не доказывают download/RLS.

## 2. Инструменты и локальные секреты

- Test1 использует PostgreSQL 17.11. Найденные DaVinci `pg_dump`/`pg_restore` 13.4 непригодны; tools в PATH, локальный PostgreSQL server и Docker в проверенных стандартных местах не обнаружены.
- Нужны PostgreSQL 17 `pg_dump`, `pg_restore` и `psql`: совместимые tools из выбранного официального Supabase image либо Windows package. [PostgreSQL Windows](https://www.postgresql.org/download/windows/) ведёт на [EDB binaries](https://www.enterprisedb.com/download-postgresql-binaries), где перечислен 17.11. Точный Windows ZIP и vendor checksum/signature проверить перед использованием; SHA256 в прочитанной binaries-странице не найден, непроверенный hash не подставлять. PostgreSQL 17 tools пока не подготовлены; проверенный Docker installer описан выше.
- Оператор вводит сохранённый пароль test1 **локально**, без передачи в чат или command arguments. Независимую сильную backup-passphrase, минимум 20 символов, хранит отдельно от backup и service key. Проверка наличия пароля не требует его раскрытия.
- Source/target credentials разделить. Перед каждой операцией закреплять source ref и новый target identity; отказать при совпадении target с test1/production. Для source DB предпочесть Session pooler 5432; TLS проверить с `verify-full`. [Supabase backup/restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).
- Проверить Windows ACL новых `.security-backups.local` и `.security-recovery.local` каталогов: POSIX `0600/0700` в Node не обеспечивает Windows ACL. Plaintext export не должен попадать в sync/public folders. Согласовать срок удаления и защищённое внешнее хранение encrypted copy.

## 3. До backup freeze

1. Закончить текущую MFA проверку; доказать удаление exact temporary ADMIN role и probe factor. При незавершённом cleanup сначала восстановить baseline.
2. Сохранить installed migration manifest+hashes и безопасный schema inventory. Проверить роли/grants, extensions, managed Auth/Storage версии, RLS/triggers, Realtime и настройки, нужные восстановлению. Пароли ролей и secret definitions в отчёт не выводить.
3. Подготовить разрешённые синтетические retained public/private файлы с известными hashes, attached/detached сценариями и A/B/C owner/member/outsider. Если Storage пуст, упражнение не доказывает физическое восстановление.
4. Проверить aggregate counts archived/versioned/delete-marker объектов. Если такие версии есть, подготовить version-aware экспорт: текущий list/download обход не доказывает их полноту.
5. Остановить test writers, frontend auto-refresh, uploads/deletes, cleanup, уведомления и другие изменяющие callbacks. Дождаться текущих операций и зафиксировать окно. `XELAY_BACKUP_WRITES_QUIESCED=true` — заявление оператора, автоматической блокировки записей инструмент не делает. Freeze сохранять до завершения SQL+Storage capture и проверки согласованности.

## 4. Копирование и восстановление

1. В новых защищённых каталогах выполнить существующие `encrypted-backup.mjs create`, затем `verify`, затем `export`. Export создаёт plaintext `database.dump` и hashed `.payload`; исходные object names остаются внутри payload, не превращаются в filesystem paths. Пароль/ключи доступны только нужному процессу и не выводятся.
2. Проверить archive TOC и зависимости до restore. Current dump охватывает только `public/auth/storage`; cluster roles, зависимости других схем и Dashboard configuration требуют отдельного inventory/export. Полноту нельзя объявлять по одному `verify`.
3. В выбранном target сначала проверить совместимость managed schemas/services. Подготовить проверенный restore adapter: application schema/data, Auth data, grants и app customizations на managed tables. Managed `auth/storage` DDL не накатывать вслепую поверх штатных таблиц. Supabase требует отдельно переносить пользовательские managed-schema изменения и физические Storage объекты. [Официальный порядок](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).
4. Выполнять SQL restore с остановкой на первой ошибке и атомарностью там, где DDL это допускает; не игнорировать ошибки или расширять ACL для их обхода. Account/SMTP/OAuth/JWT настройки относятся к новому target. Исходящие email/webhooks/cleanup выключены. Для локального stack ports доступны только loopback; production endpoints/credentials не подключать.
5. Восстановить physical bytes с согласованием bucket/path, owners, IDs и versions. Текущий инструмент uploader не предоставляет. Нужен отдельно подготовленный target-only adapter с проверками guard/reservation compatibility и offline tests. Blind service upload поверх восстановленной `storage.objects` может менять versions/owners или отказать из-за guards. Любой необходимый remapping или временное изменение защиты ограничить recovery target, зафиксировать и вернуть перед проверками.
6. Проверить абсолютные source URL в application rows: approved target-only origin mapping должен вести на восстановленные bytes. Target проверки не должны случайно скачивать файлы из test1. Source JWT нельзя использовать как доказательство target Auth: получить новые target sessions. Возобновить test1 записи после согласованного capture, независимо от дальнейшего restore в target.

Официальный `supabase db start --from-backup` предназначен для формата downloaded Supabase backup; нельзя считать наш custom `pg_dump` автоматически совместимым с этой командой. Выбранный restore adapter проверяется отдельно. [Локальное восстановление downloaded backup](https://supabase.com/docs/guides/local-development/restoring-downloaded-backup).

## 5. Что должно быть доказано

| Область | Обязательное доказательство в recovery target |
| --- | --- |
| SQL | Полнота согласованного scope: table counts, PK/FK/CHECK, migrations/functions, grants/RLS/triggers и connections между Auth/profiles/content/groups/chat; отсутствуют необъяснённые restore errors. |
| Auth | Restored user IDs/profiles и registration hook; genuine target sign-in/session, recovery flow и assurance checks с контролируемыми аккаунтами. Письма только в локальный mail sink либо разрешённый тестовый канал. Dashboard/SMTP/OAuth/JWT configuration проверяются отдельно. |
| Physical Storage | Каждый captured объект скачивается **из target**; bytes/hash/count, buckets/settings, owners, attachments и versions согласованы с БД. Допустимые remappings явно описаны. |
| Access | A/B/C и anon: owner/member положительные случаи, outsider отрицательные; public/private distinction, attached DELETE protection, detached cleanup. Проверки используют target Auth tokens. |
| Recovery operations | Recorded capture/restore times, фактический RPO/RTO, verify защищённой внешней копии, retention/passphrase recovery и удаление разрешённых temporary plaintext/target resources. |

Итоговый отчёт содержит только безопасные counts/hashes/status/times. Crypto round trip, успешный SQL load, открытие Studio или schema-only parity по отдельности не закрывают full recovery. Успех test1 упражнения также не доказывает восстановление production данных и его operational readiness.

## Следующий handoff

Ближайший gate локального варианта — **пользовательский handoff для установки WSL и проверенного Docker Desktop installer**: согласовать Windows changes и privileges, выполнить необходимые UAC/reboot действия, самостоятельно принять условия installer. После установки проверить рабочий Linux container runtime; готовность заранее не заявляется. Альтернатива B остаётся отдельным решением о новом recovery target без предполагаемой оплаты или Free-слота.

Затем согласуются отдельный target, ресурсы и доступ, restore adapter, подготовка retained fixtures, завершение MFA cleanup, freeze window и выполнение dump/download/restore. До этих действий этот файл остаётся планом; production untouched, backup/restore остаётся неподтверждённым.
