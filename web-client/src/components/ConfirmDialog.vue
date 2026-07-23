<template>
  <Teleport to="body">
    <div v-if="isOpen" class="dialog-overlay" @click.self="cancel">
      <div class="dialog-panel">
        <div class="dialog-header">
          <h3>◆ {{ title }}</h3>
        </div>
        <div class="dialog-body">
          <p>{{ message }}</p>
        </div>
        <div class="dialog-footer">
          <button class="tbtn tbtn-cancel" @click="cancel">Cancel</button>
          <button class="btn btn--danger" @click="confirm">{{ confirmLabel }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from "vue";

interface Props {
  isOpen?: boolean;
  title?: string;
  message?: string;
  confirmLabel?: string;
}

withDefaults(defineProps<Props>(), {
  isOpen: false,
  title: "Confirm",
  message: "Are you sure?",
  confirmLabel: "Confirm",
});

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();

function confirm(): void {
  emit("confirm");
}

function cancel(): void {
  emit("cancel");
}
</script>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  backdrop-filter: blur(2px);
}

.dialog-panel {
  background: var(--paper);
  border: 2.5px dashed var(--fluoro);
  padding: 20px;
  max-width: 400px;
  width: 90vw;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2), var(--sh-lift);
}

.dialog-header {
  margin-bottom: 12px;
}

.dialog-header h3 {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: .18em;
  text-transform: uppercase;
  color: var(--fluoro);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.dialog-body {
  margin-bottom: 20px;
}

.dialog-body p {
  font-family: var(--ui);
  font-size: 13px;
  color: var(--ink-soft);
  margin: 0;
  line-height: 1.5;
}

.dialog-footer {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.tbtn-cancel {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: .08em;
  text-transform: uppercase;
  border: 2px solid var(--line);
  background: var(--paper);
  padding: 7px 12px;
  cursor: pointer;
  color: var(--ink);
  text-decoration: none;
  transition: all .12s;
}

.tbtn-cancel:hover {
  box-shadow: 2px 2px 0 var(--ink);
  transform: translate(-1px, -1px);
}

.btn {
  font-family: var(--ui);
  font-weight: 700;
  font-size: 13.5px;
  text-transform: uppercase;
  letter-spacing: .08em;
  border: 2.5px solid var(--line);
  border-radius: 0;
  padding: 12px 18px;
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--paper);
  color: var(--ink);
  transition: transform .12s ease, box-shadow .12s ease, background .12s;
}

.btn--danger {
  background: var(--paper);
  color: var(--fluoro);
  border-color: var(--fluoro);
}

.btn--danger:hover {
  background: var(--fluoro);
  color: #fff;
  box-shadow: 4px 4px 0 var(--ink);
}

.btn--danger:active {
  transform: translate(0, 0);
  box-shadow: 1px 1px 0 var(--ink);
}
</style>
