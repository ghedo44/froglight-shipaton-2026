import Foundation

let vaultStorageNativeErrorPrefix = "FROGLIGHT_VAULT_ERROR"

enum VaultStorageErrorCode: String {
    case unsupported = "UNSUPPORTED"
    case invalidPath = "INVALID_PATH"
    case folderNotFound = "FOLDER_NOT_FOUND"
    case notFound = "NOT_FOUND"
    case alreadyExists = "ALREADY_EXISTS"
    case permissionDenied = "PERMISSION_DENIED"
    case conflict = "CONFLICT"
    case cancelled = "CANCELLED"
    case ioError = "IO_ERROR"
    case nativeError = "NATIVE_ERROR"
    case invalidArgument = "INVALID_ARGUMENT"
    case staleBookmark = "STALE_BOOKMARK"
}

struct VaultStoragePluginError: LocalizedError {
    let code: VaultStorageErrorCode
    let message: String
    var errorDescription: String? { message }
}

func vaultStorageError(_ code: VaultStorageErrorCode, _ message: String) -> VaultStoragePluginError {
    VaultStoragePluginError(code: code, message: message)
}

func vaultStorageRejectMessage(
    for error: Error,
    operation: String,
    url: URL? = nil,
    accessStarted: Bool? = nil,
    bookmarkStale: Bool? = nil
) -> String {
    let nsError = error as NSError
    let code: VaultStorageErrorCode
    let detail: String

    if let scoped = error as? VaultStoragePluginError {
        code = scoped.code
        detail = scoped.message
    } else if nsError.domain == NSCocoaErrorDomain {
        switch CocoaError.Code(rawValue: nsError.code) {
        case .fileNoSuchFile:
            code = .notFound
        case .fileWriteFileExists:
            code = .alreadyExists
        case .fileReadNoPermission, .fileWriteNoPermission:
            code = .permissionDenied
        default:
            code = .ioError
        }
        detail = nsError.localizedDescription
    } else {
        code = .nativeError
        detail = nsError.localizedDescription
    }

    var diagnostics = [
        "operation=\(operation)",
        "domain=\(nsError.domain)",
        "nativeCode=\(nsError.code)",
    ]
    if let url { diagnostics.append("url=\(url.absoluteString)") }
    if let accessStarted { diagnostics.append("securityScopeStarted=\(accessStarted)") }
    if let bookmarkStale { diagnostics.append("bookmarkStale=\(bookmarkStale)") }
    return "\(vaultStorageNativeErrorPrefix):\(code.rawValue):\(detail) [\(diagnostics.joined(separator: ", "))]"
}

enum VaultPath {
    static func split(_ input: String) throws -> [String] {
        let normalized = input.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\", with: "/")
        if normalized.isEmpty { return [] }
        if normalized.hasPrefix("/") || normalized.hasPrefix("~") || normalized.contains("\0") {
            throw vaultStorageError(.invalidPath, "Path must be relative")
        }
        var parts: [String] = []
        for (index, raw) in normalized.split(separator: "/", omittingEmptySubsequences: false).enumerated() {
            let segment = String(raw)
            if segment.isEmpty || segment == "." { continue }
            if segment == ".." { throw vaultStorageError(.invalidPath, "Parent segments are not allowed") }
            if index == 0 && segment.contains(":") {
                throw vaultStorageError(.invalidPath, "Absolute and URI-style paths are not allowed")
            }
            parts.append(segment)
        }
        return parts
    }

    static func join(_ left: String, _ right: String) -> String {
        [left.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
         right.trimmingCharacters(in: CharacterSet(charactersIn: "/"))]
            .filter { !$0.isEmpty }
            .joined(separator: "/")
    }
}

enum BookmarkMode: String {
    case securityScope
    case minimal
}

struct StoredFolder {
    let id: String
    let name: String?
    let uri: String?
    let mode: BookmarkMode
}

final class IOSVaultFolderStore {
    private let defaults = UserDefaults.standard
    private let prefix = "froglight_vault."

    func save(bookmark: Data, mode: BookmarkMode, name: String?, uri: String?) -> StoredFolder {
        let id = UUID().uuidString
        update(id: id, bookmark: bookmark, mode: mode, name: name, uri: uri)
        return StoredFolder(id: id, name: name, uri: uri, mode: mode)
    }

    func update(id: String, bookmark: Data, mode: BookmarkMode, name: String?, uri: String?) {
        defaults.set(bookmark, forKey: prefix + "bookmark." + id)
        defaults.set(mode.rawValue, forKey: prefix + "mode." + id)
        defaults.set(name, forKey: prefix + "name." + id)
        defaults.set(uri, forKey: prefix + "uri." + id)
    }

    func getBookmark(id: String) -> (Data, BookmarkMode)? {
        guard let data = defaults.data(forKey: prefix + "bookmark." + id) else { return nil }
        let mode = BookmarkMode(rawValue: defaults.string(forKey: prefix + "mode." + id) ?? "") ?? .minimal
        return (data, mode)
    }

    func getInfo(id: String) -> StoredFolder? {
        guard let (_, mode) = getBookmark(id: id) else { return nil }
        return StoredFolder(
            id: id,
            name: defaults.string(forKey: prefix + "name." + id),
            uri: defaults.string(forKey: prefix + "uri." + id),
            mode: mode
        )
    }

    func list() -> [StoredFolder] {
        defaults.dictionaryRepresentation().keys
            .filter { $0.hasPrefix(prefix + "bookmark.") }
            .map { $0.replacingOccurrences(of: prefix + "bookmark.", with: "") }
            .sorted()
            .compactMap(getInfo)
    }

    func remove(id: String) {
        for key in ["bookmark.", "mode.", "name.", "uri."] {
            defaults.removeObject(forKey: prefix + key + id)
        }
    }
}
