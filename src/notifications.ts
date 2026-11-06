import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification'

export type NotificationPermission = 'granted' | 'denied' | 'unavailable'

// Memoize the prompt so the scheduler asks at most once per app run.
let permissionPromise: Promise<boolean> | null = null

/** Read the current permission without prompting. */
export async function notificationPermission(): Promise<NotificationPermission> {
  try {
    return (await isPermissionGranted()) ? 'granted' : 'denied'
  } catch {
    // Browser preview / plugin unavailable.
    return 'unavailable'
  }
}

/** Prompt for permission once, sharing the result with the reminder scheduler. */
export function ensureNotificationPermission(): Promise<boolean> {
  if (!permissionPromise) {
    permissionPromise = (async () => {
      try {
        if (await isPermissionGranted()) return true
        return (await requestPermission()) === 'granted'
      } catch {
        return false
      }
    })()
  }
  return permissionPromise
}

/** Re-prompt from Settings, discarding any cached scheduler verdict. */
export async function requestNotificationPermission(): Promise<boolean> {
  permissionPromise = null
  return ensureNotificationPermission()
}
