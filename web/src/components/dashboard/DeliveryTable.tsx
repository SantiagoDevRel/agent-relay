import { useMemo } from 'react';
import type { Chat, DeliveryLane } from '@/lib/types';
import { chatProject } from '@/lib/chat-groups';

const yesNo = (value: boolean | null | undefined) => value === true ? 'Yes' : value === false ? 'No' : 'unknown';
export function deliveryStage(chat: Chat) {
  const delivery = chat.delivery;
  if (!delivery || delivery.state === 'unknown') return 'unknown';
  if (delivery.state === 'no-code') return 'No code';
  const stages = delivery.lanes.map(lane => lane.verification?.state === 'verified' ? 'verified' : lane.production === true ? 'production' : lane.ci?.state === 'failure' ? 'CI failed' : lane.onMain ? lane.ci?.state === 'success' ? 'CI passed' : 'on main' : lane.committed ? 'committed' : lane.local ? 'local' : 'unknown');
  return [...new Set(stages)].join(' / ') || 'unknown';
}
export function deliveryIndicator(chat: Chat) {
  const stage = deliveryStage(chat);
  if (stage.includes(' / ')) return 'Multi';
  return ({ production: 'Prod', verified: 'Check', committed: 'Commit', 'on main': 'Main', 'CI passed': 'CI', 'CI failed': 'Fail', unknown: '?' } as Record<string, string>)[stage] || stage;
}

function LaneCells({ lane, production }: { lane: DeliveryLane; production: boolean }) {
  return <>
    <td><span className="delivery-branch" title={`HEAD ${lane.head || 'unknown'}`}>{lane.branch}</span><details className="delivery-evidence"><summary>Worktree &amp; evidence</summary><code>{lane.worktree}</code><p>HEAD: <code>{lane.head || 'unknown'}</code></p><p>Main ({lane.mainRef || 'unknown'}): <code>{lane.mainCommit || 'unknown'}</code> {lane.method}</p>{lane.error && <p className="delivery-error">{lane.error}</p>}</details></td>
    <td title={(lane.localFiles || []).join('\n')}>{lane.local ?? 'unknown'}</td>
    <td title={`Commits ahead of ${lane.mainRef || 'unknown'} · HEAD ${lane.head || 'unknown'}`}>{lane.committed ?? 'unknown'}</td>
    <td title={`${lane.mainCommit || 'unknown'} · ${lane.method || 'No containment evidence'}`} className={lane.onMain ? 'delivery-ok' : ''}>{yesNo(lane.onMain)}</td>
    <td className={lane.ci.state === 'failure' ? 'delivery-error' : lane.ci.state === 'success' ? 'delivery-ok' : ''}><span title={lane.ci.error || lane.ci.runs.map(run => `${run.workflowName}: ${run.conclusion} · ${run.headSha} · run ${run.databaseId}`).join('\n')}>{lane.ci.state}</span>{lane.ci.runs.length > 0 && <details className="delivery-evidence"><summary>Runs</summary>{lane.ci.runs.map(run => <a key={run.databaseId} href={/^https:\/\/github\.com\//.test(run.url) ? run.url : undefined} target="_blank" rel="noreferrer" title={`${run.headSha} · ${run.conclusion}`}>{run.workflowName} · {run.databaseId}</a>)}</details>}</td>
    {production && <td title={`${lane.productionRef || 'No production ref'} · ${lane.productionSha || 'unknown'}`} className={lane.production ? 'delivery-ok' : ''}>{lane.production === undefined ? '—' : yesNo(lane.production)}</td>}
    <td title={lane.verification.sha ? `${lane.verification.sha} · ${lane.verification.ci} · ${lane.verification.prod}` : lane.verification.rejected}><span className={lane.verification.state === 'verified' ? 'delivery-ok' : ''}>{lane.verification.state}</span>{lane.verification.text && <p className="delivery-verification">{lane.verification.text}</p>}</td>
    <td>{lane.collisions.length ? <details className="delivery-evidence"><summary>{lane.collisions.length} shared files</summary><ul className="delivery-collisions">{lane.collisions.map(file => <li key={file}><code>{file}</code></li>)}</ul></details> : 'None'}</td>
  </>;
}

export function DeliveryTable({ chats, onSelect }: { chats: Chat[]; onSelect: (id: string) => void }) {
  const projects = useMemo(() => {
    const groups = new Map<string, { label: string; chats: Chat[] }>();
    for (const chat of chats) { const label = chatProject(chat) || 'Environment', key = label.toLowerCase(); const group = groups.get(key) || { label, chats: [] }; group.chats.push(chat); groups.set(key, group); }
    return [...groups].sort((a, b) => a[0].localeCompare(b[0]));
  }, [chats]);
  return <section className="delivery-projects" aria-label="Project delivery">
    <h3>Delivery</h3><p className="delivery-hint">Follow each code lane from local changes to a reported production check. Open evidence for exact commits and runs.</p>
    {!projects.length && <p className="delivery-hint">No chats to inspect.</p>}
    {projects.map(([key, project]) => {
      const production = project.chats.some(chat => chat.delivery?.lanes.some(lane => lane.productionRef));
      const collisions = [...new Set(project.chats.flatMap(chat => chat.delivery?.collisions?.map(c => c.file) || []))];
      return <details key={key} className="delivery-project" open={project.chats.some(chat => chat.alive && chat.delivery?.lanes.some(lane => lane.productionRef))}>
        <summary>{project.label} <span>{project.chats.length} chats{collisions.length ? ` · ${collisions.length} collisions` : ''}</span></summary>
        {collisions.length > 0 && <details className="delivery-project-collisions"><summary>Shared code files ({collisions.length})</summary><ul>{collisions.map(file => <li key={file}><code>{file}</code></li>)}</ul></details>}
        <div className="delivery-scroll" tabIndex={0} role="region" aria-label={`${project.label} Delivery table`}>
          <table className="delivery-table"><caption className="sr-only">{project.label} Delivery</caption><thead><tr>{['Chat', 'Branch / worktree', 'Local', 'Committed', 'On main', 'CI', ...(production ? ['Production'] : []), 'Verified', 'Collisions'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
            <tbody>{project.chats.map(chat => {
              const delivery = chat.delivery;
              if (!delivery || delivery.state !== 'attributed' || !delivery.lanes.length) return <tr key={chat.id}><th scope="row"><button onClick={() => onSelect(chat.id)}>{chat.title}</button></th><td colSpan={production ? 8 : 7}>{delivery?.state === 'no-code' ? 'No code' : 'unknown'}{delivery?.error ? ` · ${delivery.error}` : delivery?.coverage === 'pending' ? ' · collecting evidence' : delivery?.coverage === 'partial' ? ' · incomplete transcript evidence' : ''}</td></tr>;
              return delivery.lanes.map((lane, index) => <tr key={`${chat.id}-${lane.worktree}`} data-delivery-chat={chat.id}><th scope="row"><button onClick={() => onSelect(chat.id)}>{chat.title}{delivery.lanes.length > 1 ? ` · lane ${index + 1}` : ''}</button>{delivery.stale && <span className="delivery-error">Stale evidence</span>}</th><LaneCells lane={lane} production={production}/></tr>);
            })}</tbody></table>
        </div>
      </details>;
    })}
  </section>;
}
