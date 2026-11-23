export { articleProblem, blockReason, isPdf, isPublicUrl, isSupplementUrl, isWholePdf, looksLikePdfUrl, pdfLinks } from "./check.ts";
export type { Outcome } from "./download.ts";
export { findPdf, forgetHosts, paperKey } from "./find.ts";
export type { Attempt, Found, Memory, Missed, MissReason, Options, Result } from "./find.ts";
export { normalizeDoi } from "./sources.ts";
export type { Paper, Source } from "./sources.ts";
