import SwiftUI
import WidgetKit

private struct AppNotice {
    let message: String
    let code: String

    init(_ error: Error) {
        if let safe = error as? XelayError {
            message = safe.userMessage
            code = safe.supportCode
        } else {
            message = "Не вдалося виконати дію. Перевірте інтернет і спробуйте ще раз."
            code = "APP_UNAVAILABLE"
        }
    }
}

@MainActor
private final class CompanionModel: ObservableObject {
    @Published var account: Account?
    @Published var groups: [GroupChoice] = []
    @Published var snapshot: WidgetSnapshot?
    @Published var groupsTruncated = false
    @Published var notice: AppNotice?
    @Published var busy = false
    @Published var ready = false
    private var client: XelayClient?
    private var previewRevision = 0

    private func connection() throws -> XelayClient {
        if let client { return client }
        let result = try XelayClient()
        client = result
        return result
    }

    func refresh() async {
        guard !busy else { return }
        busy = true
        defer { busy = false; ready = true }
        notice = nil
        do {
            let client = try connection()
            account = try await client.account()
            if account != nil {
                groups = try await client.groups()
                groupsTruncated = try await client.groupsWereTruncated()
                WidgetCenter.shared.reloadAllTimelines()
            } else {
                groups = []; snapshot = nil
            }
        } catch {
            notice = AppNotice(error)
            if let client, let current = try? await client.account() {
                account = current
                groups = (try? await client.cachedGroups()) ?? []
                snapshot = nil
            } else {
                account = nil
                groups = []; snapshot = nil
            }
        }
    }

    func signIn(email: String, password: String) async {
        guard !busy else { return }
        busy = true
        notice = nil
        defer { busy = false; ready = true }
        do {
            let client = try connection()
            try await client.signIn(email: email, password: password)
            account = try await client.account()
            WidgetCenter.shared.reloadAllTimelines()
            groups = try await client.groups()
            groupsTruncated = try await client.groupsWereTruncated()
        } catch {
            notice = AppNotice(error)
        }
    }

    func signOut() async {
        guard !busy else { return }
        busy = true
        notice = nil
        account = nil; groups = []; snapshot = nil; previewRevision += 1
        defer {
            busy = false
            WidgetCenter.shared.reloadAllTimelines()
        }
        do {
            let client = try connection()
            try await client.signOut()
            account = nil
            groups = []; snapshot = nil; previewRevision += 1
        } catch {
            notice = AppNotice(error)
            if let client {
                account = try? await client.account()
            } else {
                account = nil
            }
            if account == nil { groups = []; snapshot = nil; previewRevision += 1 }
        }
    }

    func resetLocalData() async {
        guard !busy else { return }
        busy = true; previewRevision += 1; snapshot = nil; groups = []; account = nil
        defer { busy = false; ready = true; WidgetCenter.shared.reloadAllTimelines() }
        do { try await connection().resetLocalData(); notice = nil }
        catch { notice = AppNotice(error) }
    }

    func loadSnapshot(for choice: GroupChoice?) async {
        previewRevision += 1
        let revision = previewRevision
        snapshot = nil
        guard let choice, account?.id == choice.accountID else { return }
        do {
            let client = try connection()
            let identity = try await client.identity()
            let result = try await client.snapshot(for: choice)
            guard revision == previewRevision, account?.id == choice.accountID, try await client.identity() == identity else { return }
            snapshot = result; WidgetCenter.shared.reloadAllTimelines()
        } catch {
            guard revision == previewRevision else { return }
            notice = AppNotice(error)
        }
    }
}

private struct WidgetDestination {
    let accountID: UUID
    let groupID: UUID
    let mode: WidgetMode
    let destination: URL?

    init?(url: URL) {
        guard url.absoluteString.count <= 8192, url.scheme?.lowercased() == "xelaywidgets", url.host == "group",
              url.user == nil, url.password == nil, url.port == nil, url.path.isEmpty || url.path == "/", url.fragment == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let items = components.queryItems ?? []
        func unique(_ name: String) -> String? {
            let values = items.filter { $0.name == name }
            return values.count == 1 ? values.first?.value : nil
        }
        guard let account = unique("account"), let accountID = UUID(uuidString: account),
              let group = unique("id"), let groupID = UUID(uuidString: group),
              let modeName = unique("mode"), ["schedule", "homework"].contains(modeName) else { return nil }
        self.accountID = accountID
        self.groupID = groupID
        mode = modeName == "homework" ? .homework : .schedule
        if let raw = unique("destination") {
            guard let value = URL(string: raw), DeepLinks.isGroupURL(value, groupID: groupID) else { return nil }
            destination = value
        } else { destination = nil }
    }
}

struct XelayRootView: View {
    @StateObject private var model = CompanionModel()
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @State private var email = ""
    @State private var password = ""
    @State private var selectedID = ""
    @State private var showInstructions = false
    @State private var showPreview = false
    @State private var confirmLogout = false
    @State private var confirmReset = false
    @State private var pendingDestination: WidgetDestination?
    @State private var destinationNotice: String?
    private let accent = Color(red: 0.52, green: 0.07, blue: 0.19)

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    brand
                    if !model.ready {
                        ProgressView("Перевіряємо акаунт…").frame(maxWidth: .infinity)
                    } else if let account = model.account {
                        dashboard(account)
                    } else {
                        login
                    }
                    if let notice = model.notice {
                        VStack(alignment: .leading, spacing: 7) {
                            Label(notice.message, systemImage: "exclamationmark.circle")
                            Text("Код для підтримки: \(notice.code)").font(.caption).textSelection(.enabled)
                        }
                        .font(.callout)
                        .foregroundStyle(accent)
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 18))
                    }
                    if let destinationNotice {
                        Text(destinationNotice).font(.callout).foregroundStyle(.secondary)
                    }
                    Button("Подивитися приклад віджетів", systemImage: "rectangle.grid.1x2") { showPreview = true }
                        .frame(maxWidth: .infinity)
                    Button("Політика конфіденційності") { website("https://www.xelay.ink/privacy-policy") }
                        .font(.footnote).frame(maxWidth: .infinity)
                    Button("Очистити дані на цьому iPhone", role: .destructive) { confirmReset = true }
                        .font(.footnote).frame(maxWidth: .infinity).disabled(model.busy)
                }
                .padding(24)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showInstructions) { WidgetInstructions() }
            .sheet(isPresented: $showPreview) { WidgetDemoView() }
            .confirmationDialog("Вийти з Xelay?", isPresented: $confirmLogout, titleVisibility: .visible) {
                Button("Вийти з акаунта", role: .destructive) {
                    password = ""
                    selectedID = ""
                    Task { await model.signOut() }
                }
            } message: {
                Text("Збережені навчальні дані буде прибрано з цього iPhone. Віджети попросять увійти знову.")
            }
            .task { await refresh() }
            .confirmationDialog("Очистити локальні дані Xelay?", isPresented: $confirmReset, titleVisibility: .visible) {
                Button("Очистити й вийти", role: .destructive) {
                    password = ""; selectedID = ""; pendingDestination = nil
                    Task { await model.resetLocalData() }
                }
            } message: { Text("Сесія та кеш цього застосунку буде очищено. Ваш профіль, групи й дані на платформі залишаться. Після цього можна увійти знову.") }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await refresh() } }
            }
            .onChange(of: model.groups.map(\.id)) { _, _ in
                if !model.groups.contains(where: { $0.id == selectedID }) { selectedID = model.groups.first?.id ?? "" }
                resolveDestination()
            }
            .onChange(of: selectedID) { _, selected in
                let choice = model.groups.first { $0.id == selected }
                Task { await model.loadSnapshot(for: choice) }
            }
            .onOpenURL { url in
                if let destination = WidgetDestination(url: url) {
                    pendingDestination = destination
                    destinationNotice = nil
                    Task { await refresh() }
                }
            }
        }
    }

    private var brand: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Xelay").font(.system(size: 48, weight: .medium, design: .serif)).foregroundStyle(accent)
            Text("НАВЧАННЯ ПІД РУКОЮ").font(.caption.weight(.semibold)).tracking(2).foregroundStyle(accent)
            Text("Пари й завдання — на головному екрані iPhone.").font(.title2.bold())
        }
    }

    private var login: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Увійдіть у свій акаунт Xelay").font(.headline)
            Text("Віджети показуватимуть лише дані ваших навчальних груп.").font(.callout).foregroundStyle(.secondary)
            TextField("Електронна пошта", text: $email)
                .keyboardType(.emailAddress).textContentType(.username)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .textFieldStyle(.roundedBorder).disabled(model.busy)
            SecureField("Пароль", text: $password)
                .textContentType(.password).textFieldStyle(.roundedBorder).disabled(model.busy)
            Button {
                let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
                let secret = password
                password = ""
                Task {
                    await model.signIn(email: address, password: secret)
                    resolveDestination()
                }
            } label: {
                HStack {
                    if model.busy { ProgressView().tint(.white) }
                    Text(model.busy ? "Входимо…" : "Увійти")
                }.frame(maxWidth: .infinity).padding(.vertical, 7)
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.busy || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)
            Button("Створити акаунт або відновити пароль") { website("https://www.xelay.ink/") }
                .font(.callout)
            Text("Використовуйте наявний акаунт платформи. Пароль не зберігається; захищена сесія потрібна для оновлення віджетів.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .padding(20).background(.background, in: RoundedRectangle(cornerRadius: 24))
    }

    private func dashboard(_ account: Account) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(account.email).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            Text("Ваші віджети").font(.title2.bold())
            if model.groups.isEmpty {
                Text(model.busy ? "Завантажуємо ваші групи…" : "Ви ще не в навчальній групі. Передайте свій нік старості, щоб вас додали у Xelay.")
                    .font(.callout).foregroundStyle(.secondary)
            } else {
                Picker("Навчальна група", selection: $selectedID) {
                    ForEach(model.groups, id: \.id) { choice in Text(choice.label).tag(choice.id) }
                }.pickerStyle(.menu)
                if let choice = model.groups.first(where: { $0.id == selectedID }) {
                    Button("Відкрити розклад", systemImage: "calendar") { website(DeepLinks.webURL(for: choice, mode: .schedule)) }
                    Button("Відкрити ДЗ", systemImage: "checklist") { website(DeepLinks.webURL(for: choice, mode: .homework)) }
                }
                Text("Група на кожному віджеті обирається окремо. Можна додати кілька віджетів для різних груп.")
                    .font(.footnote).foregroundStyle(.secondary)
                if model.groupsTruncated { Text("Показано перші 50 груп. Інші доступні на платформі.").font(.footnote).foregroundStyle(.secondary) }
                if let snapshot = model.snapshot { livePreview(snapshot) }
            }
            Button("Як додати віджет", systemImage: "plus.square") { showInstructions = true }
                .buttonStyle(.borderedProminent).controlSize(.large)
            Button("Оновити список груп", systemImage: "arrow.clockwise") { Task { await refresh() } }
                .disabled(model.busy)
            Button("Відкрити платформу", systemImage: "arrow.up.right") { website("https://www.xelay.ink/groups") }
            Text("iOS сама обирає час фонового оновлення. Орієнтир — близько 30 хвилин, але система може оновлювати рідше. Час даних видно на віджеті; у браузері може знадобитися окремий вхід.")
                .font(.footnote).foregroundStyle(.secondary)
            Divider()
            Button("Вийти з акаунта", role: .destructive) { confirmLogout = true }.disabled(model.busy)
        }
        .padding(20).background(.background, in: RoundedRectangle(cornerRadius: 24))
    }

    private func refresh() async {
        await model.refresh()
        if let account = model.account, email.isEmpty { email = account.email }
        if !model.groups.contains(where: { $0.id == selectedID }) { selectedID = model.groups.first?.id ?? "" }
        await model.loadSnapshot(for: model.groups.first { $0.id == selectedID })
        resolveDestination()
    }

    private func resolveDestination() {
        guard let destination = pendingDestination else { return }
        guard let account = model.account else {
            destinationNotice = "Увійдіть в акаунт, до якого прив’язаний віджет."
            return
        }
        guard account.id == destination.accountID else {
            destinationNotice = "Цей віджет прив’язаний до іншого акаунта. Увійдіть у відповідний акаунт або змініть групу в налаштуваннях віджета."
            return
        }
        guard let choice = model.groups.first(where: { $0.accountID == account.id && $0.group.id == destination.groupID }) else {
            destinationNotice = "Групу поки не підтверджено. Оновіть список груп і перевірте свій доступ."
            return
        }
        selectedID = choice.id
        pendingDestination = nil
        destinationNotice = nil
        website(destination.destination ?? DeepLinks.webURL(for: choice, mode: destination.mode))
    }

    private func livePreview(_ snapshot: WidgetSnapshot) -> some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(alignment: .leading, spacing: 10) {
                Text("Зараз і наступні пари").font(.headline)
                ForEach(Array(snapshot.nextLessons(at: context.date).prefix(3))) { row in
                    let current = row.isCurrent(at: context.date)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(current ? "ЗАРАЗ ІДЕ ПАРА" : KyivClock.dateLabel(row.lessonDate, now: context.date)).font(.caption.bold())
                        Text(row.title).font(.subheadline.bold())
                        Text("\(row.startTime)–\(row.endTime)").font(.caption).monospacedDigit()
                    }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        .foregroundStyle(current ? WidgetPalette.currentText : Color.primary)
                        .background(current ? WidgetPalette.currentBackground : Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
                }
                if snapshot.nextLessons(at: context.date).isEmpty { Text(snapshot.upcomingSchemaVersion == nil ? "Оновіть серверні дані для поточних пар." : "Найближчих пар у доступному періоді немає.").font(.callout).foregroundStyle(.secondary) }
                Text("Найближче ДЗ").font(.headline)
                ForEach(Array(snapshot.deadlines.filter { $0.isUpcoming(at: context.date) }.prefix(3)), id: \.rowID) { row in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(row.title).font(.subheadline.bold())
                        Text(KyivClock.dateLabel(row.dueDate, now: context.date) + (row.dueAt.map { " до " + KyivClock.formatted($0, "HH:mm") } ?? " · без точного часу"))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Text("Оновлено \(KyivClock.formatted(snapshot.generatedAt, "d MMM, HH:mm")) · час Києва").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private func website(_ value: String) { if let url = URL(string: value) { website(url) } }
    private func website(_ url: URL) {
        guard url.scheme == "https", ["www.xelay.ink", "xelay.ink"].contains(url.host?.lowercased() ?? ""),
              url.user == nil, url.password == nil, url.port == nil else { return }
        openURL(url)
    }
}

private struct WidgetInstructions: View {
    @Environment(\.dismiss) private var dismiss
    private let steps = [
        "Затисніть вільне місце на головному екрані iPhone.",
        "Натисніть «Змінити» → «Додати віджет» або кнопку «+» — назва залежить від версії iOS.",
        "Знайдіть Xelay й оберіть «Зараз і наступні пари» або «Найближче ДЗ» та потрібний розмір.",
        "Додайте віджет. Затисніть його → «Змінити віджет» → оберіть свою навчальну групу й тему."
    ]
    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                        HStack(alignment: .top, spacing: 12) {
                            Text("\(index + 1)").font(.headline).foregroundStyle(.tint).frame(width: 22)
                            Text(step)
                        }.padding(.vertical, 6)
                    }
                } header: { Text("Віджет на головному екрані") }
                Section {
                    Text("Щоб змінити групу пізніше, знову затисніть віджет і відкрийте його налаштування. У списку є лише ваші групи.")
                    Text("Для кожного віджета є чотири теми: як на iPhone, світла, темна й гелловінська. Поточна пара виділяється помаранчевим.")
                    Text("Кнопка ↻ перезавантажує віджет. Оновлення потребує інтернету; фоновий розклад оновлень визначає iOS.")
                }
            }
            .navigationTitle("Додати віджет")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } } }
        }
    }
}

private struct WidgetDemoView: View {
    @Environment(\.dismiss) private var dismiss
    private let sample = WidgetSnapshot.demo
    @Environment(\.colorScheme) private var scheme
    @State private var theme: WidgetTheme = .system
    private var colors: WidgetPalette { .colors(theme, scheme: scheme) }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Демонстраційні дані").font(.caption.bold()).foregroundStyle(.secondary)
                    Text("Так виглядатиме ваш навчальний день").font(.title2.bold())
                    Picker("Тема прикладу", selection: $theme) { ForEach(WidgetTheme.allCases, id: \.self) { Text($0.label).tag($0) } }.pickerStyle(.menu)
                    demoCard(title: "Зараз і наступні пари", icon: "calendar", rows: (sample.upcomingLessons ?? []).prefix(3).map {
                        ($0.title, "\($0.startTime)–\($0.endTime)")
                    })
                    demoCard(title: "Найближче ДЗ", icon: "checklist", rows: sample.deadlines.prefix(3).map {
                        ($0.title, $0.subject ?? "Навчальне завдання")
                    })
                    Text("Це приклад, а не розклад вашої групи. Реальні дані з’являться після входу й вибору групи в налаштуваннях віджета.")
                        .font(.callout).foregroundStyle(.secondary)
                }.padding(24)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Приклад віджетів").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } } }
        }
    }
    private func demoCard(title: String, icon: String, rows: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text("Xelay").font(.system(.title3, design: .serif)); Spacer(); Image(systemName: icon) }.foregroundStyle(.tint)
            Text(title).font(.headline)
            Text(sample.group.label).font(.caption).foregroundStyle(.secondary)
             ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                HStack(alignment: .top) {
                     Capsule().fill(colors.accent).frame(width: 3, height: 35)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(row.0).font(.subheadline.bold()).lineLimit(2)
                        Text(row.1).font(.caption).foregroundStyle(index == 0 && icon == "calendar" ? WidgetPalette.currentText : colors.secondary)
                    }
                    Spacer(minLength: 0)
                }.padding(10).background(index == 0 && icon == "calendar" ? WidgetPalette.currentBackground : colors.row, in: RoundedRectangle(cornerRadius: 12))
                    .foregroundStyle(index == 0 && icon == "calendar" ? WidgetPalette.currentText : colors.primary)
            }
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(colors.primary).background(colors.background, in: RoundedRectangle(cornerRadius: 24))
    }
}
