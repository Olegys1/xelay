import Foundation

struct AppConfiguration {
    let supabaseURL: URL
    let anonymousKey: String
    let appGroup: String
    let keychainAccessGroup: String

    init(bundle: Bundle = .main) throws {
        func setting(_ key: String) throws -> String {
            guard let value = bundle.object(forInfoDictionaryKey: key) as? String,
                  !value.isEmpty, !value.contains("$("), !value.contains("REPLACE_") else {
                throw XelayError.configuration
            }
            return value
        }
        let rawURL = try setting("XelaySupabaseURL")
        guard let url = URL(string: rawURL), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.port == nil,
              url.path.isEmpty || url.path == "/", url.query == nil, url.fragment == nil else {
            throw XelayError.configuration
        }
        supabaseURL = url
        anonymousKey = try setting("XelaySupabaseAnonKey")
        appGroup = try setting("XelayAppGroup")
        keychainAccessGroup = try setting("XelayKeychainAccessGroup")
        // Only a publishable/anon key belongs in the application. A JWT that
        // declares service_role is rejected even if accidentally configured.
        let pieces = anonymousKey.split(separator: ".")
        if pieces.count == 3 {
            var payload = String(pieces[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
            if let data = Data(base64Encoded: payload),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               object["role"] as? String == "service_role" { throw XelayError.configuration }
        }
        if anonymousKey.hasPrefix("sb_secret_") { throw XelayError.configuration }
    }
}

enum XelayError: Error {
    case configuration, secureStorage, protectedData, storage, storageBusy
    case signedOut, sessionChanged, sessionExpired, accountUnavailable, membershipRequired
    case invalidCredentials, emailUnconfirmed, verificationRequired, rateLimited, network, invalidResponse
    case api(status: Int, code: String)

    var supportCode: String {
        switch self {
        case .configuration: return "APP_CONFIGURATION"
        case .secureStorage: return "SECURE_STORAGE"
        case .protectedData: return "DEVICE_LOCKED"
        case .storage: return "PRIVATE_CACHE"
        case .storageBusy: return "SESSION_BUSY"
        case .signedOut: return "AUTH_REQUIRED"
        case .sessionChanged: return "ACCOUNT_CHANGED"
        case .sessionExpired: return "AUTH_SESSION_REVOKED"
        case .accountUnavailable: return "ACCOUNT_UNAVAILABLE"
        case .membershipRequired: return "MEMBER_REQUIRED"
        case .invalidCredentials: return "INVALID_CREDENTIALS"
        case .emailUnconfirmed: return "EMAIL_NOT_CONFIRMED"
        case .verificationRequired: return "LOGIN_VERIFICATION_REQUIRED"
        case .rateLimited: return "RATE_LIMITED"
        case .network: return "NETWORK_UNAVAILABLE"
        case .invalidResponse: return "DATA_FORMAT"
        case .api(let status, _): return "HTTP_\(status)"
        }
    }
    var userMessage: String {
        switch self {
        case .configuration: return "Застосунок ще не налаштовано. Зверніться до команди Xelay."
        case .secureStorage: return "Не вдалося прочитати захищену сесію. Відкрийте застосунок і спробуйте ще раз."
        case .protectedData: return "Розблокуйте iPhone після перезапуску й відкрийте Xelay."
        case .storage: return "Не вдалося зберегти приватні дані. Спробуйте ще раз."
        case .storageBusy: return "Інше оновлення ще триває. Спробуйте трохи пізніше."
        case .signedOut, .sessionExpired: return "Увійдіть у застосунку Xelay, щоб оновлювати віджети."
        case .sessionChanged: return "Акаунт змінився. Оновіть дані."
        case .accountUnavailable: return "Не вдалося підтвердити доступ акаунта до Xelay. Перевірте пошту або зверніться до підтримки."
        case .membershipRequired: return "Доступ до цієї групи не підтверджено. Перевірте членство на платформі."
        case .invalidCredentials: return "Неправильна пошта або пароль."
        case .emailUnconfirmed: return "Підтвердьте пошту за листом від Xelay й увійдіть знову."
        case .verificationRequired: return "Для входу потрібна додаткова перевірка. Відкрийте платформу або зверніться до підтримки Xelay."
        case .rateLimited: return "Забагато запитів. Спробуйте трохи пізніше."
        case .network, .api: return "Не вдалося оновити дані. Перевірте інтернет і спробуйте ще раз."
        case .invalidResponse: return "Отримано неповні дані. Спробуйте оновити їх пізніше."
        }
    }
}
