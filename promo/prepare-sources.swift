import AppKit

enum SourcePreparationError: Error, CustomStringConvertible {
    case missingImage(String)
    case cropFailed(String)
    case encodingFailed(String)

    var description: String {
        switch self {
        case .missingImage(let path): return "Missing promo source: \(path)"
        case .cropFailed(let path): return "Could not crop promo source: \(path)"
        case .encodingFailed(let path): return "Could not encode promo source: \(path)"
        }
    }
}

// Run from the repo root: `swift promo/prepare-sources.swift`.
let projectRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
let auditRoot = projectRoot.appendingPathComponent(".codex-audit/2026-08-09-production-review", isDirectory: true)
let sourceRoot = projectRoot.appendingPathComponent("promo/sources", isDirectory: true)
let fileManager = FileManager.default

func copySource(named filename: String) throws {
    let input = auditRoot.appendingPathComponent(filename)
    let output = sourceRoot.appendingPathComponent(filename)
    guard fileManager.fileExists(atPath: input.path) else {
        throw SourcePreparationError.missingImage(input.path)
    }
    try? fileManager.removeItem(at: output)
    try fileManager.copyItem(at: input, to: output)
}

func writePublicMacSource() throws {
    let input = auditRoot.appendingPathComponent("macos-user-capture.png")
    let output = sourceRoot.appendingPathComponent("macos-workbench.png")
    guard
        let image = NSImage(contentsOf: input),
        let source = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else {
        throw SourcePreparationError.missingImage(input.path)
    }

    // Remove only the outer black capture margin while preserving the complete
    // native window: sidebar, conversation, composer, usage, and Run Inspector.
    let inset = CGRect(x: 80, y: 55, width: source.width - 160, height: source.height - 165)
    let crop = inset.integral
    guard let cropped = source.cropping(to: crop) else {
        throw SourcePreparationError.cropFailed(input.path)
    }

    let representation = NSBitmapImageRep(cgImage: cropped)
    guard let data = representation.representation(using: .png, properties: [:]) else {
        throw SourcePreparationError.encodingFailed(output.path)
    }
    try data.write(to: output, options: .atomic)
}

do {
    try fileManager.createDirectory(at: sourceRoot, withIntermediateDirectories: true)
    try copySource(named: "dashboard-desktop.png")
    try copySource(named: "tui-current.png")
    try copySource(named: "vscode-410.png")
    try writePublicMacSource()
    print("Prepared public promo sources in \(sourceRoot.path)")
} catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
