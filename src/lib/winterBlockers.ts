export const WINTER_BLOCKING_SELECTOR = [
  '.teaching-test-screen[data-active="true"]',
  '[role="dialog"][aria-modal="true"]:not([hidden])',
  'dialog[open]',
  '.xelay-dialog-backdrop',
].join(',')

export function winterDocumentBlocked(target: Pick<Document, 'fullscreenElement' | 'querySelector'>): boolean {
  return Boolean(target.fullscreenElement || target.querySelector(WINTER_BLOCKING_SELECTOR))
}
