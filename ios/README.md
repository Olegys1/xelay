# Xelay для iPhone та iPad

Нативний застосунок-компаньйон і розширення WidgetKit для iOS 17+. Застосунок і віджети збираються разом: `Xelay` (`ink.xelay.ios`) та `XelayWidgets` (`ink.xelay.ios.widgets`). Спільні Swift-файли з `Shared/` входять до обох цілей; умовні прапорці компіляції — `XELAY_APP` і `XELAY_WIDGET`.

**Поточний стан:** вихідний код і конфігурація підготовлені на Windows. Xcode тут недоступний: проєкт не компілювали, застосунок не запускали на iPhone, підписаний IPA не створювали. Наступний обов'язковий крок — збірка на Mac і перевірка на пристрої.

## Що входить

- Вхід через наявний акаунт Xelay, вибір власної навчальної групи та інструкція додавання віджетів.
- Два віджети у малому, середньому й великому розмірах: **«Зараз і наступні пари»** та **«Найближче ДЗ»**.
- До 24 найближчих занять у серверному вікні від сьогодні до сьогодні + 14 днів включно. Поточна пара виділяється помаранчевим; усі дати й час показуються за Києвом.
- До 5 найближчих строків здачі з ДЗ, довгострокових і викладацьких завдань. Якщо точний час не заданий, він не вигадується. Кількість видимих карток залежить від розміру віджета; решта доступна на платформі.
- Окрема група й одна з чотирьох тем для кожного віджета: як на iPhone, світла, темна або гелловінська.
- Кнопка ручного оновлення ↻, час останнього оновлення, офлайн-позначка й перехід до відповідної групи або завдання через застосунок.
- Приклад віджетів до входу з явно позначеними демонстраційними даними. Він не записується у приватний кеш і не підміняє реальний порожній розклад.
- Вихід із локальної сесії та окрема підтверджувана дія **«Очистити дані на цьому iPhone»** для відновлення після пошкодженого кешу чи сесії. Вона не видаляє профіль, групи й серверні дані.

Серверні RPC `xelay_android_widget_groups` і `xelay_android_widget_snapshot` спільні з Android-клієнтом. Для поточних та майбутніх пар потрібне розширення snapshot з полями `upcoming_*`; старий snapshot без них показує запит оновити серверні дані.

## Що потрібно на Mac

- Xcode 16+ або інша сумісна версія з SDK iOS 17+ і компілятором Swift 5.9+. `SWIFT_VERSION = 5.0` задає сумісний мовний режим Swift 5, а не версію компілятора.
- XcodeGen 2.42+ (`brew install xcodegen`).
- Apple Developer team з доступними App Groups і Keychain Sharing для обох цілей.
- URL поточного Supabase-проєкту та його **публічний клієнтський anon key**. Серверний `service_role`, secret key і паролі сюди не додаються.

## Налаштування й створення проєкту

У терміналі Mac, з кореня репозиторію:

```sh
brew install xcodegen
cd ios
cp Config/Local.example.xcconfig Config/Local.xcconfig
```

Відредагуйте `Config/Local.xcconfig`: заповніть `DEVELOPMENT_TEAM`, `XELAY_SUPABASE_URL` і `XELAY_SUPABASE_ANON_KEY`. Запис URL залишайте у форматі `https:/$()/PROJECT.supabase.co`: звичайне `//` в xcconfig починає коментар. Локальний файл виключений із Git.

У Certificates, Identifiers & Profiles своєї Apple Developer team зареєструйте:

1. App ID `ink.xelay.ios`.
2. App ID `ink.xelay.ios.widgets`.
3. App Group `group.ink.xelay.ios`, прив'язану до **обох** App ID.

У Signing & Capabilities обох цілей оберіть ту саму team, увімкніть App Groups і Keychain Sharing. Спільна Keychain-група — `ink.xelay.ios.shared`; у підписаних entitlement та Info.plist вона доповнюється `$(AppIdentifierPrefix)`. Префікс додає Xcode; вручну дублювати team prefix у `XELAY_KEYCHAIN_GROUP` не потрібно. Якщо ідентифікатори вже зайняті іншою team, змініть bundle ID обох цілей у `project.yml` та значення груп у локальному xcconfig узгоджено.

Сховища працюють лише за збігу підписаних App Group і Keychain-груп у застосунку та розширенні. Зміна цих значень після встановлення може вимагати повторного входу. [App Groups](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.application-groups), [спільний Keychain](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps).

Потім створіть проєкт і відкрийте його:

```sh
bash scripts/generate-project.sh
open Xelay.xcodeproj
```

Скрипт лише створює Xcode-проєкт. Еквівалент після заповнення конфігурації: `xcodegen generate --spec project.yml`. Опис цілей зберігається у `project.yml`; згенерований `.xcodeproj` виключений із Git. [Документація XcodeGen](https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md).

`WidgetIntent.swift` включений і до застосунку, і до розширення: так інтерактивна кнопка доступна в обох процесах. `XelayWidgets.swift`, `WidgetProvider.swift` і `WidgetViews.swift` входять тільки до розширення. [Інтерактивні віджети Apple](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities).

## Збірка без запуску тестів

З каталогу `ios/`, для симулятора:

```sh
xcodebuild -project Xelay.xcodeproj -scheme Xelay -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/DerivedData CODE_SIGNING_ALLOWED=NO build
```

Для підписаної збірки на пристрій, коли профілі обох цілей вже налаштовані:

```sh
xcodebuild -project Xelay.xcodeproj -scheme Xelay -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath build/DerivedData build
```

Або під'єднайте iPhone до Mac, увімкніть Developer Mode, виберіть його в Xcode й запустіть схему **Xelay**. Не встановлюйте `.appex` окремо: розширення вбудоване в застосунок. Після першого запуску й входу додайте Xelay через системне меню віджетів та оберіть доступну навчальну групу.

### Власний телефон і TestFlight

Запуск через Xcode на власному пристрої та поширення через TestFlight — різні шляхи. Apple дозволяє звичайне встановлення застосунків через безкоштовну Personal Team з короткочасними профілями, але доступність потрібних App Groups/Keychain capabilities залежить від типу membership. Для цього повного набору із спільним сховищем не слід розраховувати на Personal Team; використовуйте team з потрібними можливостями. TestFlight та App Store Connect потребують Apple Developer Program. [Облікові записи Apple Developer](https://developer.apple.com/help/account/basics/about-your-developer-account), [доступні можливості iOS](https://developer.apple.com/help/account/reference/supported-capabilities-ios).

Архів для подальшої підписаної дистрибуції на Mac:

```sh
xcodebuild -project Xelay.xcodeproj -scheme Xelay -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/Xelay.xcarchive archive
```

Архів сам по собі не є IPA чи публікацією. Експорт і завантаження виконуються через Xcode Organizer з налаштованим обліковим записом. Перед дистрибуцією також потрібні остаточний App Icon, перевірка підпису, заповнені дані App Store Connect і перевірка privacy requirements. App Icon у цьому каркасі навмисно не заданий.

## Дані, посилання й оновлення віджетів

- Вхід відбувається в нативному застосунку. Сесія зберігається у спільному Keychain; конфігураційний plist містить тільки публічні параметри підключення. Не копіюйте токени до URL, логів чи README.
- App Group призначена для спільного локального стану застосунку й віджетів. Кеш обмежений 8 МіБ, виключений з резервної копії та захищений до першого розблокування після перезапуску пристрою. Доступ до даних на сервері визначається обліковим записом та членством у групі.
- Натискання віджета відкриває `xelaywidgets://group?...` у застосунку. Це локальна URL-схема без токенів; Universal Links для сайту тут не налаштовуються.
- Кожен мережевий запит має ліміт 15 секунд; очікування завершення обмежене 16 секундами. Під час оновлення токена й повторного запиту загальний час дії може бути довшим. Відповідь обмежена 512 КіБ; HTTP-перенаправлення, cookies і URLCache для цих запитів вимкнені.
- Фонове оновлення запитується приблизно через 30 хвилин. WidgetKit визначає фактичний час за своїм бюджетом і може відкласти його. Початок/кінець пари, київська північ і завершення строку кешу також включаються у майбутні записи timeline; це не потребує окремого мережевого запиту на кожну межу. [Оновлення WidgetKit](https://developer.apple.com/documentation/widgetkit/keeping-a-widget-up-to-date).
- Ручна кнопка ↻ запускає AppIntent. Apple гарантує перезавантаження timeline після такої взаємодії; успішне отримання нових даних усе одно потребує мережі, а відображення може затриматися. Звичайний фоновий таймер не має цієї гарантії. [Інтерактивні віджети](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities).
- Приватний snapshot придатний протягом 6 годин від серверного часу створення, з допуском розбіжності годинника 90 секунд. Після цього замість даних віджет показує пропозицію оновитися. Офлайн-кеш використовується тільки для тимчасових мережевих або серверних помилок; відмова в доступі не перетворюється на офлайн-успіх.
- Назви занять і строки завдань позначені `privacySensitive`, але можуть бути видимі на екрані залежно від системних налаштувань. Враховуйте це під час вибору місця віджета. WidgetKit зберігає власні знімки інтерфейсу: вихід очищає локальні дані й запитує перезавантаження віджетів, проте миттєве видалення вже показаного системного знімка гарантувати неможливо.

Проблеми з `errSecMissingEntitlement`, порожнім App Group container або підписом спочатку перевіряйте в обох цілях: team, entitlement, App Group membership та provisioning profile мають відповідати одне одному. Не усувайте такі помилки вимкненням перевірки авторизації чи заміною публічного ключа на серверний.
