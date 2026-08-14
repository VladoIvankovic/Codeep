import AppKit
import AVFoundation
import CoreImage
import CoreVideo

struct ExportSpec {
    let filename: String
    let posterFilename: String
    let width: Int
    let height: Int
}

struct Scene {
    let kicker: String
    let headline: String
    let detail: String
    let duration: Double
    let image: CIImage?
    let isOutro: Bool
}

enum PromoError: Error, CustomStringConvertible {
    case missingAsset(String)
    case writer(String)

    var description: String {
        switch self {
        case .missingAsset(let path): return "Missing promo asset: \(path)"
        case .writer(let message): return "Video writer error: \(message)"
        }
    }
}

// Run from the repo root: `swift promo/generate-promo.swift`.
let projectRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
let sourceRoot = projectRoot.appendingPathComponent("promo/sources", isDirectory: true)
let outputRoot = projectRoot.appendingPathComponent("promo/exports", isDirectory: true)
let logoURL = projectRoot.appendingPathComponent("Codeep-web/public/img/favicons/favicon_697a83aad7a438.99312409-512x512.png")
let fps: Int32 = 24
let transitionDuration = 0.35
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
let ciContext = CIContext(options: [.cacheIntermediates: false])

let exportSpecs = [
    ExportSpec(filename: "codeep-promo-web-1920x1080.mp4", posterFilename: "codeep-promo-web-1920x1080.png", width: 1920, height: 1080),
    ExportSpec(filename: "codeep-promo-social-1080x1350.mp4", posterFilename: "codeep-promo-social-1080x1350.png", width: 1080, height: 1350),
    ExportSpec(filename: "codeep-promo-reel-1080x1920.mp4", posterFilename: "codeep-promo-reel-1080x1920.png", width: 1080, height: 1920),
]

func loadImage(_ url: URL) throws -> CIImage {
    guard FileManager.default.fileExists(atPath: url.path), let image = CIImage(contentsOf: url) else {
        throw PromoError.missingAsset(url.path)
    }
    return image.oriented(forExifOrientation: 1)
}

func alpha(_ image: CIImage, _ amount: CGFloat) -> CIImage {
    image.applyingFilter("CIColorMatrix", parameters: [
        "inputRVector": CIVector(x: 1, y: 0, z: 0, w: 0),
        "inputGVector": CIVector(x: 0, y: 1, z: 0, w: 0),
        "inputBVector": CIVector(x: 0, y: 0, z: 1, w: 0),
        "inputAVector": CIVector(x: 0, y: 0, z: 0, w: amount),
    ])
}

func scaleToFill(_ image: CIImage, size: CGSize) -> CIImage {
    let source = image.extent
    let scale = max(size.width / source.width, size.height / source.height)
    let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let x = (size.width - scaled.extent.width) / 2 - scaled.extent.origin.x
    let y = (size.height - scaled.extent.height) / 2 - scaled.extent.origin.y
    return scaled.transformed(by: CGAffineTransform(translationX: x, y: y))
        .cropped(to: CGRect(origin: .zero, size: size))
}

func scaleToFit(_ image: CIImage, rect: CGRect, zoom: CGFloat, panX: CGFloat) -> CIImage {
    let source = image.extent
    let base = min(rect.width / source.width, rect.height / source.height)
    let scale = base * zoom
    let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let x = rect.midX - scaled.extent.width / 2 - scaled.extent.origin.x + panX
    let y = rect.midY - scaled.extent.height / 2 - scaled.extent.origin.y
    return scaled.transformed(by: CGAffineTransform(translationX: x, y: y)).cropped(to: rect)
}

func roundedFrameOverlay(size: CGSize, rect: CGRect) -> CIImage {
    let width = Int(size.width)
    let height = Int(size.height)
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!
    let graphics = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    NSColor.clear.setFill()
    NSRect(origin: .zero, size: size).fill()

    let shadowPath = NSBezierPath(roundedRect: rect.insetBy(dx: -3, dy: -3), xRadius: 26, yRadius: 26)
    shadowPath.lineWidth = max(8, size.width / 210)
    NSColor(calibratedRed: 0.94, green: 0.16, blue: 0.19, alpha: 0.16).setStroke()
    shadowPath.stroke()

    let border = NSBezierPath(roundedRect: rect, xRadius: 22, yRadius: 22)
    border.lineWidth = max(2, size.width / 650)
    NSColor(calibratedRed: 0.98, green: 0.16, blue: 0.19, alpha: 0.72).setStroke()
    border.stroke()

    NSGraphicsContext.restoreGraphicsState()
    return CIImage(bitmapImageRep: rep)!
}

func textOverlay(scene: Scene, size: CGSize) throws -> CIImage {
    let width = Int(size.width)
    let height = Int(size.height)
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!
    let graphics = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    NSColor.clear.setFill()
    NSRect(origin: .zero, size: size).fill()

    let isVertical = size.height > size.width * 1.2
    let side = size.width * (isVertical ? 0.07 : 0.055)
    let top = size.height * (isVertical ? 0.075 : 0.08)
    let logoSize = size.width * (isVertical ? 0.105 : 0.055)
    let headlineSize = size.width * (isVertical ? 0.065 : 0.038)
    let detailSize = size.width * (isVertical ? 0.030 : 0.017)
    let kickerSize = size.width * (isVertical ? 0.024 : 0.013)

    guard let logo = NSImage(contentsOf: logoURL) else { throw PromoError.missingAsset(logoURL.path) }
    let logoY = size.height - top - logoSize
    logo.draw(in: CGRect(x: side, y: logoY, width: logoSize, height: logoSize), from: .zero, operation: .sourceOver, fraction: 1)

    let brandX = side + logoSize + size.width * 0.018
    let brandFont = NSFont.systemFont(ofSize: logoSize * 0.42, weight: .bold)
    ("Codeep" as NSString).draw(at: CGPoint(x: brandX, y: logoY + logoSize * 0.26), withAttributes: [
        .font: brandFont,
        .foregroundColor: NSColor.white,
    ])

    let kickerY = logoY - size.height * 0.045
    (scene.kicker as NSString).draw(at: CGPoint(x: side, y: kickerY), withAttributes: [
        .font: NSFont.monospacedSystemFont(ofSize: kickerSize, weight: .semibold),
        .foregroundColor: NSColor(calibratedRed: 0.98, green: 0.2, blue: 0.23, alpha: 1),
        .kern: kickerSize * 0.15,
    ])

    let headlineRect = CGRect(x: side, y: kickerY - headlineSize * 1.45, width: size.width - side * 2, height: headlineSize * 1.35)
    (scene.headline as NSString).draw(in: headlineRect, withAttributes: [
        .font: NSFont.systemFont(ofSize: headlineSize, weight: .bold),
        .foregroundColor: NSColor.white,
    ])

    let detailRect = CGRect(x: side, y: headlineRect.minY - detailSize * 2.3, width: size.width - side * 2, height: detailSize * 2.1)
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byWordWrapping
    (scene.detail as NSString).draw(in: detailRect, withAttributes: [
        .font: NSFont.systemFont(ofSize: detailSize, weight: .medium),
        .foregroundColor: NSColor(calibratedWhite: 0.76, alpha: 1),
        .paragraphStyle: paragraph,
    ])

    let footerSize = size.width * (isVertical ? 0.024 : 0.013)
    ("codeep.dev" as NSString).draw(at: CGPoint(x: side, y: size.height * 0.035), withAttributes: [
        .font: NSFont.monospacedSystemFont(ofSize: footerSize, weight: .medium),
        .foregroundColor: NSColor(calibratedWhite: 0.62, alpha: 1),
    ])

    NSGraphicsContext.restoreGraphicsState()
    return CIImage(bitmapImageRep: rep)!
}

func background(size: CGSize, source: CIImage?) -> CIImage {
    let bounds = CGRect(origin: .zero, size: size)
    let base = CIImage(color: CIColor(red: 0.012, green: 0.012, blue: 0.014, alpha: 1)).cropped(to: bounds)
    guard let source else {
        let glow = CIFilter(name: "CIRadialGradient", parameters: [
            "inputCenter": CIVector(x: size.width * 0.76, y: size.height * 0.68),
            "inputRadius0": size.width * 0.03,
            "inputRadius1": size.width * 0.78,
            "inputColor0": CIColor(red: 0.42, green: 0.015, blue: 0.025, alpha: 0.82),
            "inputColor1": CIColor(red: 0.01, green: 0.01, blue: 0.012, alpha: 0),
        ])!.outputImage!.cropped(to: bounds)
        return glow.composited(over: base)
    }

    let fill = scaleToFill(source, size: size)
        .applyingFilter("CIGaussianBlur", parameters: ["inputRadius": max(24, size.width * 0.028)])
        .cropped(to: bounds)
        .applyingFilter("CIColorControls", parameters: [
            kCIInputBrightnessKey: -0.38,
            kCIInputContrastKey: 1.05,
            kCIInputSaturationKey: 0.58,
        ])
    let redWash = CIImage(color: CIColor(red: 0.16, green: 0.0, blue: 0.012, alpha: 0.42)).cropped(to: bounds)
    let shade = CIImage(color: CIColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.28)).cropped(to: bounds)
    return shade.composited(over: redWash.composited(over: fill.composited(over: base)))
}

func render(scene: Scene, progress: Double, size: CGSize) throws -> CIImage {
    let bounds = CGRect(origin: .zero, size: size)
    var result = background(size: size, source: scene.image)
    let isVertical = size.height > size.width * 1.2

    if let source = scene.image {
        let cardWidth = size.width * (isVertical ? 0.88 : 0.68)
        let cardHeight = size.height * (isVertical ? 0.46 : 0.50)
        let cardX = (size.width - cardWidth) / 2
        let cardY = size.height * (isVertical ? 0.11 : 0.06)
        let cardRect = CGRect(x: cardX, y: cardY, width: cardWidth, height: cardHeight)
        let zoom = 1 + CGFloat(progress) * 0.035
        let pan = (CGFloat(progress) - 0.5) * size.width * 0.018

        let cardBase = CIImage(color: CIColor(red: 0.025, green: 0.025, blue: 0.028, alpha: 1)).cropped(to: cardRect)
        let fitted = scaleToFit(source, rect: cardRect.insetBy(dx: cardWidth * 0.018, dy: cardHeight * 0.025), zoom: zoom, panX: pan)
        result = fitted.composited(over: cardBase.composited(over: result))
        result = roundedFrameOverlay(size: size, rect: cardRect).composited(over: result)
    }

    result = try textOverlay(scene: scene, size: size).composited(over: result)
    return result.cropped(to: bounds)
}

func scenes() throws -> [Scene] {
    [
        Scene(kicker: "AGENT WORK, MADE VISIBLE", headline: "SEE THE WHOLE RUN", detail: "Codeep turns agent work into a clear execution timeline.", duration: 1.55, image: nil, isOutro: false),
        Scene(kicker: "DASHBOARD", headline: "TRACK EVERY SESSION", detail: "Tokens, cost and resource estimates in one place.", duration: 1.9, image: try loadImage(sourceRoot.appendingPathComponent("dashboard-desktop.png")), isOutro: false),
        Scene(kicker: "TERMINAL", headline: "STAY IN THE FLOW", detail: "Plan → Read → Edit → Verify → Summary.", duration: 1.9, image: try loadImage(sourceRoot.appendingPathComponent("tui-current.png")), isOutro: false),
        Scene(kicker: "MACOS", headline: "A NATIVE WORKBENCH", detail: "Conversation, files and checks — side by side.", duration: 1.9, image: try loadImage(sourceRoot.appendingPathComponent("macos-workbench.png")), isOutro: false),
        Scene(kicker: "VS CODE", headline: "BUILT INTO YOUR EDITOR", detail: "Live activity, controls and run summary.", duration: 1.9, image: try loadImage(sourceRoot.appendingPathComponent("vscode-410.png")), isOutro: false),
        Scene(kicker: "CODEEP", headline: "CODE WITH CLARITY", detail: "Dashboard · Terminal · macOS · VS Code", duration: 1.7, image: nil, isOutro: true),
    ]
}

func timeline(for scenes: [Scene]) -> ([Double], Double) {
    var starts = [0.0]
    for index in 1..<scenes.count {
        starts.append(starts[index - 1] + scenes[index - 1].duration - transitionDuration)
    }
    return (starts, starts.last! + scenes.last!.duration)
}

func frameImage(time: Double, scenes: [Scene], starts: [Double], size: CGSize) throws -> CIImage {
    var index = 0
    for candidate in starts.indices where starts[candidate] <= time {
        index = candidate
    }
    let scene = scenes[index]
    let local = max(0, min(1, (time - starts[index]) / scene.duration))
    let current = try render(scene: scene, progress: local, size: size)

    guard index + 1 < scenes.count else { return current }
    let transitionStart = starts[index + 1]
    guard time >= transitionStart else { return current }
    let mix = CGFloat(max(0, min(1, (time - transitionStart) / transitionDuration)))
    let nextProgress = max(0, min(1, (time - starts[index + 1]) / scenes[index + 1].duration))
    let next = try render(scene: scenes[index + 1], progress: nextProgress, size: size)
    return alpha(next, mix).composited(over: current)
}

func writePoster(_ image: CIImage, to url: URL, size: CGSize) throws {
    try ciContext.writePNGRepresentation(
        of: image.cropped(to: CGRect(origin: .zero, size: size)),
        to: url,
        format: .RGBA8,
        colorSpace: colorSpace
    )
}

func exportVideo(spec: ExportSpec, scenes: [Scene], starts: [Double], totalDuration: Double) throws {
    let size = CGSize(width: spec.width, height: spec.height)
    let outputURL = outputRoot.appendingPathComponent(spec.filename)
    let posterURL = outputRoot.appendingPathComponent(spec.posterFilename)
    try? FileManager.default.removeItem(at: outputURL)

    let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: spec.width,
        AVVideoHeightKey: spec.height,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: spec.width >= 1900 ? 9_000_000 : 7_000_000,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        ],
    ])
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: spec.width,
        kCVPixelBufferHeightKey as String: spec.height,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:],
    ])
    guard writer.canAdd(input) else { throw PromoError.writer("Cannot add H.264 input") }
    writer.add(input)
    guard writer.startWriting() else { throw PromoError.writer(writer.error?.localizedDescription ?? "startWriting failed") }
    writer.startSession(atSourceTime: .zero)

    guard let pool = adaptor.pixelBufferPool else { throw PromoError.writer("Pixel buffer pool unavailable") }
    let frameCount = Int(ceil(totalDuration * Double(fps)))
    for frame in 0..<frameCount {
        while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
        var buffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let pixelBuffer = buffer else {
            throw PromoError.writer("Could not allocate frame \(frame)")
        }
        let time = Double(frame) / Double(fps)
        let image = try frameImage(time: time, scenes: scenes, starts: starts, size: size)
        ciContext.render(image, to: pixelBuffer, bounds: CGRect(origin: .zero, size: size), colorSpace: colorSpace)
        let presentationTime = CMTime(value: Int64(frame), timescale: fps)
        guard adaptor.append(pixelBuffer, withPresentationTime: presentationTime) else {
            throw PromoError.writer(writer.error?.localizedDescription ?? "append failed at frame \(frame)")
        }
    }

    input.markAsFinished()
    let semaphore = DispatchSemaphore(value: 0)
    writer.finishWriting { semaphore.signal() }
    semaphore.wait()
    guard writer.status == .completed else {
        throw PromoError.writer(writer.error?.localizedDescription ?? "finishWriting failed")
    }

    let posterTime = starts[1] + 0.65
    try writePoster(try frameImage(time: posterTime, scenes: scenes, starts: starts, size: size), to: posterURL, size: size)
    print("Exported \(spec.filename) (\(spec.width)×\(spec.height), \(String(format: "%.2f", totalDuration))s)")
}

do {
    try FileManager.default.createDirectory(at: outputRoot, withIntermediateDirectories: true)
    let promoScenes = try scenes()
    let (starts, duration) = timeline(for: promoScenes)
    for spec in exportSpecs {
        try exportVideo(spec: spec, scenes: promoScenes, starts: starts, totalDuration: duration)
    }
} catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
