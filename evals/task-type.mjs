// Deterministic task type and specification signals for a chat's first prompt.
import { normalize, ownWords } from './corrections.mjs';

const URL = /\b(?:https?:\/\/|www\.)\S+/gi;

export const TASK_TYPES = ['feature', 'bugfix', 'research', 'ops', 'docs', 'design', 'review', 'other'];

// Priority order breaks score ties. Patterns run on normalized text (no accents).
const TYPE_PATTERNS = [
  ['bugfix', /\b(fix|fixes|fixing|bug|bugs|broken|crash|crashes|regression|failing|fails|error|errors|arregla|arreglar|arreglame|corrige|corregir|falla|fallando|no funciona|no sirve|roto|rota)\b/g],
  ['review', /\b(review|reviews|revisa|revisar|revision|audit|audita|auditar|auditoria|code review|second opinion|segunda opinion)\b/g],
  ['research', /\b(research|investiga|investigar|investigacion|compare|compara|comparar|averigua|explain|explica|explicame|why does|por que|how does|como funciona|analyze|analiza|analizar|evaluate|evalua|recommend|recomienda|recomiendame)\b/g],
  ['docs', /\b(readme|docs|documentation|documentacion|documenta|documentar|changelog|guide|guia|tutorial|jsdoc)\b/g],
  ['design', /\b(ui|ux|design|diseno|disena|redesign|redisena|layout|css|styles?|estilos?|figma|mockup|landing|theme|colors?|colores|typography|tipografia|animation|animacion)\b/g],
  ['ops', /\b(deploy|despliega|desplegar|install|instala|instalar|configure|configura|configurar|setup|set up|pipeline|server|servidor|dgx|docker|vercel|backup|respaldo|migrate|migra|dns|domain|dominio|cron|ssh|tailscale|upgrade)\b/g],
  ['feature', /\b(add|implement|implementa|implementar|build|create|crea|crear|construye|construir|agrega|agregar|anade|anadir|feature|support|integrate|integra|integrar|haz|hazme|make)\b/g],
];

/**
 * Classifies the first prompt: each type scores its keyword matches, and a match in
 * the first eight words (the leading imperative) adds 3. Ties follow TYPE_PATTERNS
 * order; no match → 'other'. Only the user's own words count, without URLs
 * ("docs.google.com" in a link does not make a chat a docs chat).
 */
export function classifyTaskType(prompt) {
  const text = normalize(ownWords(prompt).replace(URL, ' ')).slice(0, 4000);
  if (!text) return 'other';
  const lead = text.split(' ').slice(0, 8).join(' ');
  let best = 'other', bestScore = 0;
  for (const [type, pattern] of TYPE_PATTERNS) {
    const score = (text.match(pattern)?.length ?? 0) + ((lead.match(pattern)?.length ?? 0) > 0 ? 3 : 0);
    if (score > bestScore) { best = type; bestScore = score; }
  }
  return best;
}

const SIGNALS = [
  ['agent-relay-spec', /\bagent-relay-spec\b/],
  ['contract-file', /[\w./\\-]*(contract|contrato|spec|requirements|requisitos)[\w.-]*\.(json|md|ya?ml)\b/],
  ['checklist-reference', /\bchecklist[\w-]*\.md\b|\bchecklist-requisitos\b/],
  ['requirements-section', /\b(requirements|requisitos|requerimientos)\b\**\s*:|^#{1,6}\s*(requirements|requisitos|requerimientos)\b/m],
  ['acceptance-section', /\b(acceptance( criteria)?|criterios de aceptacion|aceptacion|verification|verificacion|definition of done|done when)\b\**\s*:|^#{1,6}\s*(acceptance|criterios de aceptacion|aceptacion|verification|verificacion|definition of done)\b/m],
  ['numbered-requirements', null],
  ['ai-pack', /<!--\s*ai-pack/],
];

function numberedRequirements(text) {
  const lines = text.split(/\r?\n/).filter(line => /^\s*(\d{1,2}[.)]|[-*]\s+\[[ x]\])\s+\S/i.test(line)).length;
  const ids = new Set(text.match(/\bR\d{1,2}\b/g) ?? []);
  return lines >= 3 || ids.size >= 2;
}

/**
 * Specification signals of a prompt. hasSpec needs a referenced spec/contract/
 * checklist (agent-relay-spec, contract-file, checklist-reference), or explicit
 * requirements (requirements-section or numbered-requirements) plus an
 * acceptance/verification section. ai-pack is reported but is not enough alone.
 */
export function detectSpec(prompt) {
  const raw = String(prompt ?? '');
  // Keep line breaks for headings and numbered lists; compare without accents.
  const text = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const signals = [];
  for (const [name, pattern] of SIGNALS) {
    const hit = name === 'numbered-requirements' ? numberedRequirements(raw) : pattern.test(text);
    if (hit) signals.push(name);
  }
  const has = name => signals.includes(name);
  const hasSpec = has('agent-relay-spec') || has('contract-file') || has('checklist-reference')
    || ((has('requirements-section') || has('numbered-requirements')) && has('acceptance-section'));
  return { hasSpec, signals };
}
