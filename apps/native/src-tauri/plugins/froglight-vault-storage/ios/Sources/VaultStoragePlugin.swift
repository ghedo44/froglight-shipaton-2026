import Foundation
import os
import SwiftRs
import UniformTypeIdentifiers
import UIKit
import Tauri

struct FolderHandleDTO: Encodable {
    let id: String
    let name: String?
    let uri: String?
}

struct PickFolderResponseDTO: Encodable { let folder: FolderHandleDTO }
struct ListFoldersResponseDTO: Encodable { let folders: [FolderHandleDTO] }

struct DirEntryDTO: Encodable {
    let name: String
    let path: String
    let isFile: Bool
    let isDir: Bool
    let size: UInt64?
    let mimeType: String?
    let lastModified: Int64?
}

struct FileStatDTO: Encodable {
    let name: String
    let path: String
    let isFile: Bool
    let isDir: Bool
    let size: UInt64?
    let mimeType: String?
    let lastModified: Int64?
}

struct ReadDirResponseDTO: Encodable { let entries: [DirEntryDTO] }
struct ReadFileResponseDTO: Encodable { let data: String }

struct FolderIdArgs: Decodable { let folderId: String }
struct ReadDirArgs: Decodable { let folderId: String; let path: String? }
struct StatArgs: Decodable { let folderId: String; let path: String }
struct ReadFileArgs: Decodable { let folderId: String; let path: String }
struct WriteFileArgs: Decodable {
    let folderId: String
    let path: String
    let data: String
    let expectedChecksum: String?
    let dataPath: String?
    let mimeType: String?
    let recursive: Bool?
}
struct MkdirArgs: Decodable { let folderId: String; let path: String; let recursive: Bool? }
struct RemoveFileArgs: Decodable { let folderId: String; let path: String }
struct RemoveDirArgs: Decodable { let folderId: String; let path: String; let recursive: Bool? }
struct RenameArgs: Decodable { let folderId: String; let fromPath: String; let toPath: String }

@available(iOS 14.0, *)
final class VaultStoragePlugin: Plugin, UIDocumentPickerDelegate {
    // Tauri shares one IPC queue across plugins. Vault I/O gets its own serial
    // queue so a File Provider write cannot hold up unrelated native commands.
    private let storageQueue = DispatchQueue(label: "io.froglight.vault-storage", qos: .userInitiated)
    private let queueLock = NSLock()
    private var pendingOperations = 0
    private let storageLog = OSLog(subsystem: "io.froglight", category: "vault-storage")
    private var pendingInvoke: Invoke?
    private let folderStore = IOSVaultFolderStore()
    private let cacheLock = NSLock()
    private var cachedURLs: [String: URL] = [:]

    @objc public func pickFolder(_ invoke: Invoke) {
        DispatchQueue.main.async {
            guard let presenter = self.topPresenter() else {
                invoke.reject("\(vaultStorageNativeErrorPrefix):NATIVE_ERROR:No active view controller available")
                return
            }
            if self.pendingInvoke != nil {
                invoke.reject("\(vaultStorageNativeErrorPrefix):INVALID_ARGUMENT:A folder picker request is already in progress")
                return
            }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.pendingInvoke = invoke
            presenter.present(picker, animated: true)
        }
    }

    @objc public func forgetFolder(_ invoke: Invoke) {
        runVoid(invoke, operation: "forgetFolder") {
            let args = try invoke.parseArgs(FolderIdArgs.self)
            self.folderStore.remove(id: args.folderId)
            self.cacheLock.lock()
            self.cachedURLs.removeValue(forKey: args.folderId)
            self.cacheLock.unlock()
        }
    }

    @objc public func listFolders(_ invoke: Invoke) {
        run(invoke, operation: "listFolders") {
            ListFoldersResponseDTO(folders: self.folderStore.list().map(self.folderDTO))
        }
    }

    @objc public func readDir(_ invoke: Invoke) {
        run(invoke, operation: "readDir") {
            let args = try invoke.parseArgs(ReadDirArgs.self)
            return try self.withFolderURL(folderId: args.folderId, operation: "readDir") { folderURL in
                let dir = try args.path.map { try self.resolveExistingChildURL(base: folderURL, relPath: $0) } ?? folderURL
                return try self.coordinatedRead(at: dir) { coordinatedDir in
                    var isDirectory: ObjCBool = false
                    guard FileManager.default.fileExists(atPath: coordinatedDir.path, isDirectory: &isDirectory), isDirectory.boolValue else {
                        throw vaultStorageError(.invalidArgument, "Path is not a directory")
                    }
                    let keys: Set<URLResourceKey> = [.nameKey, .isDirectoryKey, .fileSizeKey, .contentModificationDateKey, .contentTypeKey]
                    let entries = try FileManager.default.contentsOfDirectory(
                        at: coordinatedDir,
                        includingPropertiesForKeys: Array(keys),
                        options: []
                    ).map { try self.dirEntryDTO(url: $0, basePath: args.path ?? "", resourceKeys: keys) }
                    return ReadDirResponseDTO(entries: entries)
                }
            }
        }
    }

    @objc public func stat(_ invoke: Invoke) {
        run(invoke, operation: "stat") {
            let args = try invoke.parseArgs(StatArgs.self)
            return try self.withFolderURL(folderId: args.folderId, operation: "stat") { folderURL in
                let target = try self.resolveExistingChildURL(base: folderURL, relPath: args.path)
                return try self.coordinatedRead(at: target) { coordinatedTarget in
                    try self.fileStatDTO(
                        url: coordinatedTarget,
                        path: args.path,
                        resourceKeys: [.nameKey, .isDirectoryKey, .fileSizeKey, .contentModificationDateKey, .contentTypeKey]
                    )
                }
            }
        }
    }

    @objc public func readFile(_ invoke: Invoke) {
        run(invoke, operation: "readFile") {
            let args = try invoke.parseArgs(ReadFileArgs.self)
            let data = try self.withFolderURL(folderId: args.folderId, operation: "readFile") { folderURL in
                let target = try self.requireFile(base: folderURL, relPath: args.path)
                return try self.coordinatedRead(at: target) { try Data(contentsOf: $0) }
            }
            return ReadFileResponseDTO(data: data.base64EncodedString())
        }
    }

    @objc public func writeFile(_ invoke: Invoke) {
        runVoid(invoke, operation: "writeFile") {
            let args = try invoke.parseArgs(WriteFileArgs.self)
            let bytes: Data
            if let path = args.dataPath {
                bytes = try Data(contentsOf: URL(fileURLWithPath: path), options: [.mappedIfSafe])
            } else {
                guard let decoded = Data(base64Encoded: args.data), args.data.utf8.count % 4 == 0 else {
                    throw vaultStorageError(.invalidArgument, "data must be canonical base64")
                }
                let tailCount = decoded.count % 3
                if tailCount > 0 && !args.data.hasSuffix(decoded.suffix(tailCount).base64EncodedString()) {
                    throw vaultStorageError(.invalidArgument, "data must be canonical base64")
                }
                bytes = decoded
            }
            try self.withFolderURL(folderId: args.folderId, operation: "writeFile") { folderURL in
                let (parent, name) = try self.resolveParentURL(base: folderURL, relPath: args.path, recursive: args.recursive ?? false)
                try self.coordinatedContainerWrite(at: parent) { coordinatedParent in
                    let target = coordinatedParent.appendingPathComponent(name, isDirectory: false)
                    var isDirectory: ObjCBool = false
                    if FileManager.default.fileExists(atPath: target.path, isDirectory: &isDirectory), isDirectory.boolValue {
                        throw vaultStorageError(.invalidArgument, "Target is a directory")
                    }
                    if let expected = args.expectedChecksum {
                        let current = try Data(contentsOf: target, options: [.mappedIfSafe])
                        var hash: UInt32 = 0x811c9dc5
                        for byte in current { hash = (hash ^ UInt32(byte)) &* 0x01000193 }
                        guard String(format: "%08x", hash) == expected else {
                            throw vaultStorageError(.conflict, "Vault file changed; local edits are retained")
                        }
                    }
                    try bytes.write(to: target, options: [.atomic])
                }
            }
        }
    }

    @objc public func mkdir(_ invoke: Invoke) {
        runVoid(invoke, operation: "mkdir") {
            let args = try invoke.parseArgs(MkdirArgs.self)
            try self.withFolderURL(folderId: args.folderId, operation: "mkdir") { folderURL in
                let (parent, name) = try self.resolveParentURL(base: folderURL, relPath: args.path, recursive: args.recursive ?? false)
                try self.coordinatedContainerWrite(at: parent) { coordinatedParent in
                    let target = coordinatedParent.appendingPathComponent(name, isDirectory: true)
                    var isDirectory: ObjCBool = false
                    if FileManager.default.fileExists(atPath: target.path, isDirectory: &isDirectory) {
                        if (args.recursive ?? false) && isDirectory.boolValue { return }
                        throw vaultStorageError(.alreadyExists, "Directory already exists: \(args.path)")
                    }
                    try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
                }
            }
        }
    }

    @objc public func removeFile(_ invoke: Invoke) {
        runVoid(invoke, operation: "removeFile") {
            let args = try invoke.parseArgs(RemoveFileArgs.self)
            try self.withFolderURL(folderId: args.folderId, operation: "removeFile") { folderURL in
                let target = try self.requireFile(base: folderURL, relPath: args.path)
                try self.coordinatedDelete(at: target)
            }
        }
    }

    @objc public func removeDir(_ invoke: Invoke) {
        runVoid(invoke, operation: "removeDir") {
            let args = try invoke.parseArgs(RemoveDirArgs.self)
            try self.withFolderURL(folderId: args.folderId, operation: "removeDir") { folderURL in
                let target = try self.requireDirectory(base: folderURL, relPath: args.path)
                if !(args.recursive ?? false) {
                    let contents = try self.coordinatedRead(at: target) {
                        try FileManager.default.contentsOfDirectory(atPath: $0.path)
                    }
                    if !contents.isEmpty {
                        throw vaultStorageError(.invalidArgument, "Directory not empty")
                    }
                }
                try self.coordinatedDelete(at: target)
            }
        }
    }

    @objc public func rename(_ invoke: Invoke) {
        runVoid(invoke, operation: "rename") {
            let args = try invoke.parseArgs(RenameArgs.self)
            try self.withFolderURL(folderId: args.folderId, operation: "rename") { folderURL in
                let source = try self.resolveExistingChildURL(base: folderURL, relPath: args.fromPath)
                let (destinationParent, destinationName) = try self.resolveParentURL(base: folderURL, relPath: args.toPath, recursive: true)
                let destination = destinationParent.appendingPathComponent(destinationName)
                if FileManager.default.fileExists(atPath: destination.path) {
                    throw vaultStorageError(.alreadyExists, "Destination already exists: \(args.toPath)")
                }
                try self.coordinatedMove(from: source, to: destination)
            }
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else {
            pendingInvoke?.reject("\(vaultStorageNativeErrorPrefix):CANCELLED:No folder selected")
            pendingInvoke = nil
            return
        }

        guard let invoke = pendingInvoke else { return }
        pendingInvoke = nil
        storageQueue.async {
            let accessStarted = url.startAccessingSecurityScopedResource()
            defer {
                if accessStarted { url.stopAccessingSecurityScopedResource() }
            }

            do {
                try self.writeProbe(at: url)
                let (bookmark, mode) = try self.makeBookmark(for: url)
                let name = (try? url.resourceValues(forKeys: [.nameKey]).name) ?? url.lastPathComponent
                let stored = self.folderStore.save(bookmark: bookmark, mode: mode, name: name, uri: url.absoluteString)
                self.cache(url, for: stored.id)
                invoke.resolve(PickFolderResponseDTO(folder: self.folderDTO(stored)))
            } catch {
                invoke.reject(vaultStorageRejectMessage(
                    for: error,
                    operation: "pickFolder.writeProbeOrBookmark",
                    url: url,
                    accessStarted: accessStarted,
                    bookmarkStale: false
                ))
            }
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pendingInvoke?.reject("\(vaultStorageNativeErrorPrefix):CANCELLED:User cancelled")
        pendingInvoke = nil
    }

    private func enqueue(_ invoke: Invoke, operation: String, _ block: @escaping () -> Void) {
        queueLock.lock()
        guard pendingOperations < 64 else {
            queueLock.unlock()
            invoke.reject("\(vaultStorageNativeErrorPrefix):IO_ERROR:Vault I/O queue is full")
            return
        }
        pendingOperations += 1
        queueLock.unlock()
        let queued = DispatchTime.now().uptimeNanoseconds
        storageQueue.async {
            let started = DispatchTime.now().uptimeNanoseconds
            let signpost = OSSignpostID(log: self.storageLog)
            os_signpost(.begin, log: self.storageLog, name: "Vault operation", signpostID: signpost,
                        "%{public}@ queue_us=%llu", operation as NSString, (started - queued) / 1000)
            defer {
                os_signpost(.end, log: self.storageLog, name: "Vault operation", signpostID: signpost)
                self.queueLock.lock()
                self.pendingOperations -= 1
                self.queueLock.unlock()
            }
            block()
        }
    }

    private func run<T: Encodable>(_ invoke: Invoke, operation: String, _ block: @escaping () throws -> T) {
        enqueue(invoke, operation: operation) {
            do { invoke.resolve(try block()) }
            catch { invoke.reject(vaultStorageRejectMessage(for: error, operation: operation)) }
        }
    }

    private func runVoid(_ invoke: Invoke, operation: String, _ block: @escaping () throws -> Void) {
        enqueue(invoke, operation: operation) {
            do { try block(); invoke.resolve() }
            catch { invoke.reject(vaultStorageRejectMessage(for: error, operation: operation)) }
        }
    }

    private func folderDTO(_ folder: StoredFolder) -> FolderHandleDTO {
        FolderHandleDTO(id: folder.id, name: folder.name, uri: folder.uri)
    }

    private func cache(_ url: URL, for id: String) {
        cacheLock.lock(); cachedURLs[id] = url; cacheLock.unlock()
    }

    private func cachedURL(for id: String) -> URL? {
        cacheLock.lock(); defer { cacheLock.unlock() }
        return cachedURLs[id]
    }

    private func withFolderURL<T>(folderId: String, operation: String, _ block: (URL) throws -> T) throws -> T {
        guard let stored = folderStore.getBookmark(id: folderId) else {
            throw vaultStorageError(.folderNotFound, "Folder not found: \(folderId)")
        }

        var stale = false
        let url: URL
        if let cached = cachedURL(for: folderId) {
            url = cached
        } else {
            url = try URL(
                resolvingBookmarkData: stored.0,
                options: .withoutUI,
                relativeTo: nil,
                bookmarkDataIsStale: &stale
            )
            cache(url, for: folderId)
        }

        let accessStarted = url.startAccessingSecurityScopedResource()
        defer { if accessStarted { url.stopAccessingSecurityScopedResource() } }

        if stale {
            let (bookmark, mode) = try makeBookmark(for: url)
            let info = folderStore.getInfo(id: folderId)
            folderStore.update(
                id: folderId,
                bookmark: bookmark,
                mode: mode,
                name: info?.name ?? url.lastPathComponent,
                uri: url.absoluteString
            )
        }

        do {
            return try block(url)
        } catch {
            let diagnostic = vaultStorageRejectMessage(
                for: error,
                operation: operation,
                url: url,
                accessStarted: accessStarted,
                bookmarkStale: stale
            )
            let parts = diagnostic.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
            let code = parts.count > 1 ? String(parts[1]) : "NATIVE_ERROR"
            let detail = parts.count > 2 ? String(parts[2]) : diagnostic
            let mapped = VaultStorageErrorCode(rawValue: code) ?? .nativeError
            throw vaultStorageError(mapped, detail)
        }
    }

    private func makeBookmark(for url: URL) throws -> (Data, BookmarkMode) {
        let bookmark = try url.bookmarkData(
            options: .minimalBookmark,
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        return (bookmark, .minimal)
    }

    private func writeProbe(at folderURL: URL) throws {
        let name = ".froglight-write-probe-\(UUID().uuidString)"
        try coordinatedContainerWrite(at: folderURL) { coordinatedFolder in
            let probe = coordinatedFolder.appendingPathComponent(name, isDirectory: false)
            defer { try? FileManager.default.removeItem(at: probe) }
            try Data("froglight".utf8).write(to: probe, options: [])
            let readBack = try Data(contentsOf: probe)
            guard readBack == Data("froglight".utf8) else {
                throw vaultStorageError(.ioError, "Write probe verification failed")
            }
            try FileManager.default.removeItem(at: probe)
        }
    }

    private func resolveChildURL(base: URL, relPath: String, isDirectory: Bool = false) throws -> URL {
        let components = try VaultPath.split(relPath)
        if components.isEmpty { throw vaultStorageError(.invalidPath, "Path must not be empty") }
        var url = base
        for (index, component) in components.enumerated() {
            let last = index == components.count - 1
            url.appendPathComponent(component, isDirectory: isDirectory && last)
        }
        return url
    }

    private func resolveExistingChildURL(base: URL, relPath: String) throws -> URL {
        let url = try resolveChildURL(base: base, relPath: relPath)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw vaultStorageError(.notFound, "Path not found: \(relPath)")
        }
        return url
    }

    private func resolveParentURL(base: URL, relPath: String, recursive: Bool) throws -> (URL, String) {
        let components = try VaultPath.split(relPath)
        guard let name = components.last else { throw vaultStorageError(.invalidPath, "Path must not be empty") }
        var current = base
        for component in components.dropLast() {
            let next = current.appendingPathComponent(component, isDirectory: true)
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: next.path, isDirectory: &isDirectory) {
                guard isDirectory.boolValue else {
                    throw vaultStorageError(.invalidArgument, "Path segment is not a directory: \(component)")
                }
                current = next
            } else {
                guard recursive else { throw vaultStorageError(.notFound, "Parent directory missing") }
                try coordinatedContainerWrite(at: current) { coordinatedParent in
                    let child = coordinatedParent.appendingPathComponent(component, isDirectory: true)
                    try FileManager.default.createDirectory(at: child, withIntermediateDirectories: false)
                }
                current = next
            }
        }
        return (current, name)
    }

    private func requireFile(base: URL, relPath: String) throws -> URL {
        let url = try resolveExistingChildURL(base: base, relPath: relPath)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            throw vaultStorageError(.invalidArgument, "Path is not a file")
        }
        return url
    }

    private func requireDirectory(base: URL, relPath: String) throws -> URL {
        let url = try resolveExistingChildURL(base: base, relPath: relPath)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw vaultStorageError(.invalidArgument, "Path is not a directory")
        }
        return url
    }

    private func coordinatedRead<T>(at url: URL, _ block: (URL) throws -> T) throws -> T {
        var coordinatorError: NSError?
        var result: T?
        var blockError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &coordinatorError) { coordinatedURL in
            do { result = try block(coordinatedURL) } catch { blockError = error }
        }
        if let error = coordinatorError { throw error }
        if let error = blockError { throw error }
        guard let value = result else { throw vaultStorageError(.ioError, "File coordination produced no result") }
        return value
    }

    private func coordinatedContainerWrite(at url: URL, _ block: (URL) throws -> Void) throws {
        var coordinatorError: NSError?
        var blockError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: .forMerging, error: &coordinatorError) { coordinatedURL in
            do { try block(coordinatedURL) } catch { blockError = error }
        }
        if let error = coordinatorError { throw error }
        if let error = blockError { throw error }
    }

    private func coordinatedDelete(at url: URL) throws {
        var coordinatorError: NSError?
        var blockError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: .forDeleting, error: &coordinatorError) { coordinatedURL in
            do { try FileManager.default.removeItem(at: coordinatedURL) } catch { blockError = error }
        }
        if let error = coordinatorError { throw error }
        if let error = blockError { throw error }
    }

    private func coordinatedMove(from source: URL, to destination: URL) throws {
        var coordinatorError: NSError?
        var blockError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(
            writingItemAt: source,
            options: .forMoving,
            writingItemAt: destination,
            options: .forMoving,
            error: &coordinatorError
        ) { coordinatedSource, coordinatedDestination in
            do { try FileManager.default.moveItem(at: coordinatedSource, to: coordinatedDestination) }
            catch { blockError = error }
        }
        if let error = coordinatorError { throw error }
        if let error = blockError { throw error }
    }

    private func dirEntryDTO(url: URL, basePath: String, resourceKeys: Set<URLResourceKey>) throws -> DirEntryDTO {
        let values = try url.resourceValues(forKeys: resourceKeys)
        let name = values.name ?? url.lastPathComponent
        let isDir = values.isDirectory ?? false
        return DirEntryDTO(
            name: name,
            path: VaultPath.join(basePath, name),
            isFile: !isDir,
            isDir: isDir,
            size: values.fileSize.map(UInt64.init),
            mimeType: values.contentType?.preferredMIMEType,
            lastModified: values.contentModificationDate.map { Int64($0.timeIntervalSince1970) }
        )
    }

    private func fileStatDTO(url: URL, path: String, resourceKeys: Set<URLResourceKey>) throws -> FileStatDTO {
        let values = try url.resourceValues(forKeys: resourceKeys)
        let isDir = values.isDirectory ?? false
        return FileStatDTO(
            name: values.name ?? url.lastPathComponent,
            path: path,
            isFile: !isDir,
            isDir: isDir,
            size: values.fileSize.map(UInt64.init),
            mimeType: values.contentType?.preferredMIMEType,
            lastModified: values.contentModificationDate.map { Int64($0.timeIntervalSince1970) }
        )
    }

    private func topPresenter() -> UIViewController? {
        var controller = manager.viewController
        while let presented = controller?.presentedViewController { controller = presented }
        return controller
    }
}

@_cdecl("init_plugin_froglight_vault_storage")
@available(iOS 14.0, *)
func initPluginFroglightVaultStorage() -> Plugin {
    VaultStoragePlugin()
}
