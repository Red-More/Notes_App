/**
 * Best-effort haptic feedback.
 *
 * Tauri's WebView exposes the Vibration API on Android; desktop browsers are a
 * no-op, which keeps every caller platform-agnostic.
 */
export function hapticTap(pattern: number | number[] = 12): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern)
    }
  } catch {
    // Haptics are optional; never let them break an interaction.
  }
}
