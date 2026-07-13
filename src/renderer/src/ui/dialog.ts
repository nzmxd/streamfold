import { readonly, shallowRef } from 'vue'

export type DialogTone = 'default' | 'warning' | 'danger'

export interface ConfirmDialogOptions {
  title: string
  description: string
  details?: string[]
  confirmLabel?: string
  cancelLabel?: string
  tone?: DialogTone
}

interface DialogRequest extends Required<Omit<ConfirmDialogOptions, 'details'>> {
  id: number
  details: string[]
  resolve: (value: boolean) => void
}

let sequence = 0
const active = shallowRef<DialogRequest | null>(null)
const queue: DialogRequest[] = []

function showNext(): void {
  if (!active.value) active.value = queue.shift() ?? null
}

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({
      id: ++sequence,
      title: options.title,
      description: options.description,
      details: options.details ?? [],
      confirmLabel: options.confirmLabel ?? '确认',
      cancelLabel: options.cancelLabel ?? '取消',
      tone: options.tone ?? 'default',
      resolve
    })
    showNext()
  })
}

export function settleDialog(value: boolean): void {
  const request = active.value
  if (!request) return
  active.value = null
  request.resolve(value)
  showNext()
}

export const dialogState = readonly(active)
