/** Show a transient toast message from anywhere. */
export function toast(msg: string) {
  window.dispatchEvent(new CustomEvent('app-toast', { detail: msg }))
}
