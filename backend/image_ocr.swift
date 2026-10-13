import Foundation
import Vision
import ImageIO

do {
    guard CommandLine.arguments.count == 2,
          let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        exit(2)
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    request.usesCPUOnly = true
    try VNImageRequestHandler(cgImage: image).perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    let result = try JSONSerialization.data(withJSONObject: ["text": text])
    FileHandle.standardOutput.write(result)
} catch {
    let problem = error as NSError
    FileHandle.standardError.write(Data("\(problem.domain):\(problem.code)".utf8))
    exit(3)
}
