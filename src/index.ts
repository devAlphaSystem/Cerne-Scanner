export { detectDocument, scanDocument } from "./scanner";
export { warmupScanner } from "./opencv";
export { releaseScannerResources } from "./runtime";

export type { DetectOptions, DetectionMetadata, DetectionMethod, DetectionResult, DocumentCorners, DocumentDetection, EncodedScanData, EnhancementMode, InputImageFormat, OutputEncoding, OutputFormat, OutputOptions, PaperSize, PerformanceProfile, Point, ScanErrorCode, ScanErrorInfo, ScanInput, ScanMetadata, ScanOptions, ScanOutputInfo, ScanResult, ScanStatus } from "./types";
