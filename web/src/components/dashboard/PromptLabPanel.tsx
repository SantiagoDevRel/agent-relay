import { useEffect, useState } from 'react';
import { WandSparkles } from 'lucide-react';
import { ApiError, getMissionCatalog } from '@/lib/api';
import type { MissionCatalog } from '@/lib/types';
import { PromptRefinement } from './PromptRefinement';
import { ProjectSelector } from './ProjectSelector';

// What one Prompt Lab click runs. Keep in sync with server/prompt-refiner.mjs and the
// planner turn cap in server/mission-runner.mjs.
const HOW_IT_WORKS: { name: string; text: string }[] = [
  { name: 'Skill', text: 'agent-relay-spec (skills/agent-relay-spec/SKILL.md), loaded in full as the instructions.' },
  { name: 'Script', text: 'server/prompt-refiner.mjs builds the request and checks the answer; server/mission-runner.mjs runs the turn through tools/ai-chat.mjs.' },
  { name: 'Prompt instructions', text: 'Keep every explicit requirement with a literal quote and an observable criterion, never drop or swap a hard one, ask only questions that change the work, and add a verification plan. Prose is in English; your quotes keep their language.' },
  { name: 'Model', text: 'The provider, model and effort you pick above (Codex with high effort by default), through your subscription, never an API key.' },
  { name: 'Limits', text: 'One read-only turn, at most 15 minutes; Claude also stops after 24 tool steps. It reads only the project you select, never edits files or runs builds, and never retries on its own.' },
  { name: 'Result', text: 'Your original prompt in full, the improved prompt, acceptance criteria and a verification plan, ready to copy. Attempts and logs stay in Preparation history.' },
];

export function PromptLabPanel({ active, connected }: { active: boolean; connected: boolean }) {
  const [prompt, setPrompt] = useState(''), [done, setDone] = useState(''), [project, setProject] = useState('');
  const [catalog, setCatalog] = useState<MissionCatalog | null>(null), [catalogError, setCatalogError] = useState('');
  useEffect(() => {
    if (!active || !connected) return;
    const controller = new AbortController();
    getMissionCatalog(controller.signal).then(value => { if (!controller.signal.aborted) { setCatalog(value); setCatalogError(''); } })
      .catch(cause => { if (!controller.signal.aborted) setCatalogError(cause instanceof ApiError ? cause.detail || cause.code : 'Could not load the installed models.'); });
    return () => controller.abort();
  }, [active, connected]);
  return <section className="panel page-panel prompt-lab-panel" aria-labelledby="prompt-lab-title">
    <header className="page-panel-heading"><h2 id="prompt-lab-title"><WandSparkles size={18} aria-hidden="true" />Prompt Lab</h2><p className="dialog-note">Paste a prompt and get a clearer, testable version to copy into any chat.</p></header>
    <div className="prompt-lab-body relay-fields">
      <label>Your prompt<textarea required minLength={10} maxLength={20000} rows={8} placeholder="Paste the prompt you want to improve" value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
      <label>What done looks like (optional)<textarea maxLength={20000} rows={3} placeholder="For example: the page loads in under a second and every existing test passes" value={done} onChange={event => setDone(event.target.value)} /></label>
      <details className="mission-evidence"><summary>Reference project (optional)</summary><p className="dialog-note">Lets the model read that project’s code and rules so the prompt fits it.</p><ProjectSelector value={project} onChange={setProject} active={active} connected={connected} required={false} disabled={!connected} /></details>
      {catalogError ? <p className="assistant-warning" role="alert">{catalogError}</p> : null}
      {!connected ? <p className="assistant-warning" role="alert">Prompt Lab needs the Agent Relay server. Start it and reload.</p> : null}
      <PromptRefinement kind="lab" goal={prompt} acceptance={done} project={project || undefined} catalog={catalog} disabled={!connected} />
    </div>
    <section className="prompt-lab-about" aria-labelledby="prompt-lab-about-title">
      <h3 id="prompt-lab-about-title">How Prompt Lab works</h3>
      <ul>{HOW_IT_WORKS.map(item => <li key={item.name}><strong>{item.name}:</strong> {item.text}</li>)}</ul>
    </section>
  </section>;
}
