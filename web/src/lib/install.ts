import { useSyncExternalStore } from 'react';

// Chrome offers to install the dashboard as an app (own window and taskbar icon)
// through `beforeinstallprompt`; the event must be replayed from a click.
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

let pending: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  pending = event as InstallPromptEvent;
  emit();
});
window.addEventListener('appinstalled', () => {
  pending = null;
  emit();
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useCanInstall = () => useSyncExternalStore(subscribe, () => pending !== null);

export async function installApp() {
  const prompt = pending;
  if (!prompt) return;
  await prompt.prompt();
  await prompt.userChoice;
  pending = null;
  emit();
}
