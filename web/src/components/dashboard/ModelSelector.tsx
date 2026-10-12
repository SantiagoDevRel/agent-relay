import type { MissionCatalog, ModelSelection } from '@/lib/types';

export function modelEfforts(catalog: MissionCatalog | null, selection: ModelSelection) {
  const provider = catalog?.[selection.provider];
  const configured = provider?.currentModel?.id;
  return provider?.models.find(item => item.id === (selection.model || configured))?.efforts ?? provider?.efforts ?? [];
}
export function modelSelectionReady(catalog: MissionCatalog | null, selection: ModelSelection) {
  const provider = catalog?.[selection.provider];
  const selected = provider?.models.find(item => item.id === (selection.model || provider.currentModel?.id));
  const supported = selection.model ? selected?.managedSupported : provider?.currentModel?.managedSupported ?? selected?.managedSupported;
  return Boolean(provider?.available && supported !== false && (selection.effort === '' || modelEfforts(catalog, selection).includes(selection.effort)));
}

export function ModelSelector({ catalog, value, onChange, disabled, error, label = 'Model and reasoning' }: {
  catalog: MissionCatalog | null; value: ModelSelection; onChange: (value: ModelSelection) => void; disabled?: boolean; error?: string; label?: string;
}) {
  const provider = catalog?.[value.provider];
  const efforts = modelEfforts(catalog, value);
  const selected = provider?.models.find(item => item.id === (value.model || provider.currentModel?.id));
  const current = provider?.currentModel;
  const managedSupported = value.model ? selected?.managedSupported : current?.managedSupported ?? selected?.managedSupported;
  const updateModel = (model: string) => {
    const next = { ...value, model };
    const compatible = modelEfforts(catalog, next);
    const defaultEffort = provider?.models.find(item => item.id === model)?.defaultEffort;
    onChange({ ...next, effort: value.effort === '' || compatible.includes(value.effort) ? value.effort : defaultEffort && compatible.includes(defaultEffort) ? defaultEffort : compatible.includes('high') ? 'high' : compatible[0] || '' });
  };
  return <div className="model-selector relay-fields" aria-label={label}>
    <div className="mission-model-fields">
      <label>Provider<select disabled={disabled} value={value.provider} onChange={event => { const next = { provider: event.target.value as ModelSelection['provider'], model: '', effort: 'high' }; const supported = modelEfforts(catalog, next); onChange({ ...next, effort: supported.includes('high') ? 'high' : '' }); }}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
      <label>Model<select disabled={disabled || !provider?.available} value={value.model} onChange={event => updateModel(event.target.value)}><option value="">{current?.id ? `Configured: ${current.id}` : 'CLI default · ID unconfirmed'}</option>{provider?.models.filter(item => item.id).map(item => <option key={item.id} value={item.id}>{item.label && item.label !== item.id ? `${item.label} · ` : ''}{item.id}{(item.dynamic || item.kind === 'alias') && !item.label?.includes('alias') ? ' · dynamic alias' : ''}</option>)}</select></label>
      <label>Reasoning<select disabled={disabled || !provider?.available} value={efforts.includes(value.effort) ? value.effort : ''} onChange={event => onChange({ ...value, effort: event.target.value })}><option value="">Model default</option>{efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>
    </div>
    {error ? <p className="assistant-warning" role="alert">{error}</p> : !catalog ? <p className="dialog-note" role="status">Loading your CLI model catalogs…</p> : !provider?.available ? <p className="assistant-warning" role="alert">{provider?.detail || provider?.error || `${value.provider === 'codex' ? 'Codex' : 'Claude'} is unavailable. Check its installation and sign-in.`}</p> : null}
    {provider?.available ? <p className="dialog-note model-identity">Model: <code>{value.model || current?.id || 'Default ID unconfirmed'}</code>{selected?.resolvedId || (!value.model && current?.resolvedId) ? <> · Resolved ID: <code>{selected?.resolvedId || current?.resolvedId}</code></> : null}{selected?.dynamic || selected?.kind === 'alias' ? ' · The provider resolves this alias; it is not a fixed version.' : null}</p> : null}
    {provider?.catalogError ? <p className="dialog-note">{provider.catalogError}</p> : null}
    {value.effort && !efforts.includes(value.effort) && provider?.available ? <p className="assistant-warning" role="alert">The level {value.effort} is unavailable for this model. Select a supported level or its default.</p> : null}
    {managedSupported === false ? <p className="assistant-warning" role="alert">{selected?.managedReason || current?.managedReason || selected?.billingNote || current?.billingNote || 'This model is not enabled for managed turns with your current authorization.'}</p> : selected?.billingNote ? <p className="dialog-note">{selected.billingNote}</p> : null}
    {provider?.workflows?.length ? <div className="workflow-selection"><label>Work mode<select value="standard" disabled={disabled} onChange={() => {}}><option value="standard">Managed standard</option>{provider.workflows.map(workflow => <option key={workflow.id} value={workflow.id} disabled>{workflow.label} · unavailable with managed limits</option>)}</select></label>{provider.workflows.map(workflow => <p className="dialog-note" key={workflow.id}><strong>{workflow.label}:</strong> {workflow.reason || 'This workflow does not support managed chat limits.'}</p>)}</div> : null}
  </div>;
}
