import { CircleHelp, CircleCheck, CirclePause, LoaderCircle, Unplug } from 'lucide-react';
import type { ChatState } from '@/lib/types';
export const states = {
  working: { label: 'Working', plural: 'Working', Icon: LoaderCircle },
  waiting: { label: 'Waiting for you', plural: 'Waiting for you', Icon: CirclePause },
  cut: { label: 'Interrupted', plural: 'Interrupted', Icon: Unplug },
  closed: { label: 'Closed', plural: 'Closed', Icon: CircleCheck },
  unknown: { label: 'Unknown', plural: 'Unknown', Icon: CircleHelp },
};
export function StateBadge({ state }: { state: ChatState }) {
  const { label, Icon } = states[state];
  return <span className={`state-badge state-${state}`}><Icon size={13} aria-hidden="true" />{label}</span>;
}
