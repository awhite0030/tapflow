import type { PerformanceMode } from '@/lib/decoders/pickDecoder';

// The auto-show policy for the performance-mode notice. Kept out of the component file so that file
// exports only components — mixing the two breaks Vite's Fast Refresh for its consumers — and so the
// policy stays unit-testable without importing the dialog.
export const PERF_NOTICE_KEY = 'tapflow.perfModeNoticeDismissed';

// Auto-show only in Standard mode and only if not dismissed before (once per browser).
export function shouldAutoShowPerfNotice(mode: PerformanceMode, dismissed: boolean): boolean {
  return mode === 'standard' && !dismissed;
}
