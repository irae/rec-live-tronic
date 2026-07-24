<template>
  <div class="toast-host" aria-live="polite">
    <transition-group name="toast" tag="div" class="toast-stack">
      <div v-for="t in toasts" :key="t.id" class="toast">{{ t.message }}</div>
    </transition-group>
  </div>
</template>

<script setup lang="ts">
import { useToast } from "../composables/useToast";

const { toasts } = useToast();
</script>

<style scoped>
.toast-host {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 20px;
  z-index: 200;
  display: flex;
  justify-content: center;
  pointer-events: none;
  padding: 0 16px;
}

.toast-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 420px;
}

.toast {
  pointer-events: auto;
  font-family: var(--mono);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: .06em;
  color: var(--paper);
  background: var(--ink);
  border: 2px solid var(--line);
  box-shadow: var(--sh);
  padding: 9px 14px;
  text-align: center;
  max-width: 100%;
}

.toast-move,
.toast-enter-active,
.toast-leave-active {
  transition: opacity .18s ease, transform .18s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (max-width: 640px) {
  .toast-host {
    bottom: auto;
    top: 12px;
  }

  .toast {
    font-size: 11.5px;
    padding: 10px 14px;
  }

  .toast-enter-from,
  .toast-leave-to {
    transform: translateY(-8px);
  }
}
</style>
