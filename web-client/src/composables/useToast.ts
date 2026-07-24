import { reactive } from "vue";

export interface Toast {
  id: number;
  message: string;
}

const DISMISS_MS = 10_000;

// Module-level so every caller shares one stack -- ToastHost.vue is mounted
// once in App.vue and renders whatever any component pushed via toast().
const toasts = reactive<Toast[]>([]);
let nextId = 1;

function toast(message: string): void {
  const id = nextId++;
  toasts.push({ id, message });
  setTimeout(() => {
    const idx = toasts.findIndex((t) => t.id === id);
    if (idx >= 0) toasts.splice(idx, 1);
  }, DISMISS_MS);
}

export function useToast() {
  return { toast, toasts };
}
