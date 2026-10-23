// E3 correction detector: deterministic Spanish/English rules over the user's
// follow-up prompts and a closure-claim detector for agent replies. Claude labels
// (evals/claude-labels.mjs) replace these rules wherever they exist; the rules are
// the fallback for messages Claude has not labeled.
//
// Rules see only the user's own words (ownWords): pasted blocks, the agent's side of
// question replies and messages written by another agent are removed first.
//
// Rules run on normalized text: lower case, accents removed (ñ → n), inverted
// punctuation dropped and whitespace collapsed, so informal text without accents
// ("no sirvio", "esta mal") matches the same patterns as accented text.
// RULES order is the priority: the first matching rule labels the message.
// wrong-result → incomplete → misunderstood → redo → scope → process → language-style.

export const CATEGORIES = ['wrong-result', 'incomplete', 'misunderstood', 'scope', 'process', 'language-style', 'redo', 'other'];

export function normalize(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[‘’`´]/g, "'").replace(/[¿¡]/g, ' ').replace(/\s+/g, ' ').trim()
    // Contractions typed without the apostrophe ("doesnt", "thats").
    .replace(/\b(doesn|don|didn|isn|aren|wasn|won|haven|hasn|couldn|shouldn|wouldn)t\b/g, "$1't")
    .replace(/\b(that|what|it|everything)s\b/g, "$1's");
}

// Collapses whitespace and truncates to max characters (ellipsis included).
export function excerpt(text, max = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

// statementOnly rules ignore sentences that end with a question mark
// ("¿qué hace falta para cerrar?" asks for status; it reports nothing missing).
function rule(id, category, lang, include, exclude, positives, negatives, { statementOnly = false } = {}) {
  const hit = n => include.test(n) && !(exclude && exclude.test(n));
  return {
    id, category, lang, positives, negatives,
    test(text) {
      const n = normalize(text);
      return statementOnly ? n.split(/(?<=[.!?])\s+/).some(sentence => !/\?\s*$/.test(sentence) && hit(sentence)) : hit(n);
    },
  };
}

const PASTED = /<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content\b[^>]*>|$)/gi;
const QUESTION_REPLY = /<send_user_message_question_reply>([\s\S]*?)(?:<\/send_user_message_question_reply>|$)/gi;
// "Claude: …", "Claude (supervisor). …", "SUPERVISOR (Claude): …": another agent wrote the message into this chat.
const AGENT_AUTHOR = /^\s*(?:(?:claude|codex|grok|kimi|gemini)(?:\s*\([^)\n]{1,40}\))?|[\w ]{1,30}\((?:claude|codex|grok|kimi|gemini)\b[^)\n]{0,30}\))\s*[:.]\s/i;
// Relay prompts and Relay deliveries (the user's text lives in a file the agent reads).
const RELAY_PROMPT = /<!--\s*agent-relay-|^\s*AGENT-RELAY MESSAGE\b/i;

function answers(body) {
  try {
    const list = JSON.parse(body.trim());
    if (Array.isArray(list)) return list.map(item => (typeof item?.answer === 'string' ? item.answer : '')).filter(Boolean);
  } catch { /* Truncated replies fall back to the answer fields that survived. */ }
  return [...body.matchAll(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(match => { try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; } });
}

/**
 * The user's own words in a prompt: '' for messages another agent or Relay wrote,
 * only the answers of a question reply (never the agent's question), and pasted
 * blocks replaced by a marker.
 */
export function ownWords(text) {
  const value = String(text ?? '');
  if (AGENT_AUTHOR.test(value) || RELAY_PROMPT.test(value)) return '';
  return value.replace(QUESTION_REPLY, (_, body) => answers(body).join('\n')).replace(PASTED, ' [pasted text omitted] ').trim();
}

export const RULES = [
  // ---- wrong-result ----
  rule('es-no-funciona', 'wrong-result', 'es',
    /\bno ?(me |te |le |nos )?(funciona|funcionan|funciono|funcionaron|funcionaba|funsiona|funca|anda|carga|abre|compila|corre|arranca|prende)\b/,
    /\bsi (eso |esto |algo |el \w+ |la \w+ )?no (me |te |le )?(funciona|funcionan|funca|anda|carga|abre|compila|corre|arranca|prende)\b|\bno corre prisa\b/,
    ['no funciona, sigue saliendo Hello en español', 'Nofunciona el login', 'todavía no funciona el botón', 'no me carga la página', 'no compila'],
    ['funciona perfecto, gracias', 'si no funciona, avísame', 'no te preocupes por eso', 'no corre prisa, mañana lo vemos']),
  rule('es-sigue-mal', 'wrong-result', 'es',
    /\bsiguen? (igual|fallando|saliendo|sin funcionar|sin servir|mal|roto|rota|rotos|apareciendo|pasando|en rojo|dando (error|errores|el mismo)|(con )?(el |los )?(mismo |mismos )?(error|errores|bug|problema))\b|\bsiguen? sin (funcionar|servir|cargar|aparecer|salir|arreglarse|compilar)\b/,
    null,
    ['sigue igual', 'sigue fallando el test', 'sigue saliendo el mismo mensaje', 'siguen en rojo los checks', 'sigue sin cargar'],
    ['sigue así, vas muy bien', 'sigue con el siguiente paso']),
  rule('es-sale-error', 'wrong-result', 'es',
    /\b(el|un|otra vez el|de nuevo el) mismo (error|problema|bug|fallo)\b|\b(sale|salio|da|dio|tira|tiro|bota|boto|aparece|aparecio) (un |el |otro |este |ese )?(error|exception|excepcion|pantallazo)\b/,
    /\bsi (te |me |le )?(sale|da|tira|bota|aparece)\b|\bque error\b.*\?/,
    ['me sale este error: TypeError', 'otra vez el mismo error', 'da error al guardar', 'bota un error en consola'],
    ['si sale un error, muéstramelo', '¿qué error da la API de pagos cuando la tarjeta falla?']),
  rule('es-esta-mal', 'wrong-result', 'es',
    /\b(esta|estan|quedo|quedaron|salio|salieron|esto es|eso es|todo) (mal|malo|mala|incorrecto|incorrecta|equivocado|equivocada|pailas|roto|rota|mal hecho)\b|\bmal hecho\b|\bes incorrect[oa]\b/,
    /\bno (esta|estan|es|quedo) (mal|malo|mala)\b|\bnada mal\b|\bsi (algo )?esta mal\b/,
    ['está mal el cálculo del total', 'quedó pailas el diseño', 'eso es incorrecto', 'esto quedo roto'],
    ['no está mal, me gusta', 'nada mal para un primer intento']),
  rule('es-lo-rompiste', 'wrong-result', 'es',
    /\b(rompiste|danaste|jodiste|tumbaste|totiaste|desbarataste|borraste)\b|\bse (dano|jodio|totio) (todo|el|la|los|las)\b/,
    null,
    ['lo rompiste todo', 'me dañaste el layout', 'rompiste el build', 'se dañó todo después del cambio'],
    ['no rompas nada del backend', 'se cayó la API del proveedor, no es tu culpa']),
  rule('es-no-sirve', 'wrong-result', 'es',
    /\bno (me |nos |le )?(sirve|sirven|sirvio)\b/,
    /\bsi no (me |te |le )?sirve\b/,
    ['no sirve', 'eso no me sirve', 'no sirvió el cambio'],
    ['si no te sirve, lo cambiamos']),
  rule('es-dijiste-listo', 'wrong-result', 'es',
    /\bdijiste que (ya )?(estaba|quedo|quedaba|funcionaba|servia|habias|lo habias|era)\b|\b(no|nunca) (estaba|quedo|quedaba) (listo|terminado|funcionando)\b/,
    null,
    ['dijiste que estaba listo y no', 'dijiste que ya funcionaba', 'nunca quedó listo'],
    ['dijiste que mañana hay demo, ¿cierto?']),
  rule('en-doesnt-work', 'wrong-result', 'en',
    /\b(doesn't|does not|didn't|did not|won't|will not|isn't|aren't|wasn't|not|nothing) (work|works|working|load|loads|loading|compile|compiles|compiling|render|renders|rendering|start|starts|starting)\b/,
    /\bif (it |this |that |the \w+ )?(doesn't|does not|didn't|won't|isn't)\b|\b(do not|don't) work\b|\bnot working on\b/,
    ["it doesn't work", 'the login still is not working', 'nothing works after the update', "the page won't load"],
    ['it works now, thanks', "if it doesn't work, ping me", "don't work on the backend yet", "I'm not working on that today"]),
  rule('en-still-broken', 'wrong-result', 'en',
    /\bstill (broken|failing|fails|failed|wrong|the same|getting|seeing|shows|showing|crashing|crashes|throws|throwing|erroring|errors|red|happening)\b|\bsame (error|issue|problem|bug|result|output)\b/,
    null,
    ['still broken', 'the tests are still failing', 'same error as before', 'it still shows the old title'],
    ['are you still working on it?', 'I still need to think about the pricing']),
  rule('en-wrong', 'wrong-result', 'en',
    /\b(that's|this is|that is|it's|it is|totally|completely|all|looks|is|are|was) wrong\b|\bwrong (output|result|answer|file|value|number|color|colour|page|place|branch|repo|folder|order|format|language|version)\b|\b(incorrect|not correct)\b/,
    /\bwhat's wrong\b|\bwhat is wrong\b|\b(anything|something|nothing) (is |was )?wrong\b|\bwhat went wrong\b|\bif (anything|something|it) (goes|is|looks) wrong\b/,
    ["that's wrong", 'the total is wrong', 'you used the wrong file', 'this output is incorrect'],
    ["what's wrong with the API?", 'nothing is wrong, just checking', 'if anything goes wrong, stop and tell me']),
  rule('en-broke', 'wrong-result', 'en',
    /\byou (broke|have broken|'ve broken|messed up|screwed up|deleted|removed|wiped)\b|\b(it's|it is|everything is|everything's|now|is now|are now) broken\b/,
    null,
    ['you broke the build', 'everything is broken now', 'you messed up the layout', "it's broken"],
    ['the broken link checker is a nice idea']),
  rule('en-said-done', 'wrong-result', 'en',
    /\byou (said|claimed|told me|reported)( that)?( it| this| everything| the \w+)?( was| is| were)? (done|fixed|working|finished|ready|complete|passing|green)\b/,
    null,
    ['you said it was fixed', 'you claimed everything was done', 'you told me the tests were passing'],
    ['you said the demo is on Friday']),

  // ---- incomplete ----
  rule('es-falta', 'incomplete', 'es',
    /\b(falta|faltan|falto|faltaron)\b/,
    /\b(falta|faltan) (poco|mucho|nada|un poco|muy poco)\b|\bno (falta|faltan|hace falta)\b|\b(que|algo) (mas )?(falta|faltan)\b.*\?|\bfalta de\b|\bsin falta\b/,
    ['falta el botón de guardar', 'faltó actualizar el README', 'te faltan los tests', 'hace falta la validación'],
    ['falta poco para el demo', 'mañana sin falta lo revisamos', '¿qué más falta?', 'todo quedó listo o qué hace falta para cerrar este chat?'],
    { statementOnly: true }),
  rule('es-se-te-olvido', 'incomplete', 'es',
    /\bse te (olvido|olvidaron|paso|pasaron|escapo|escaparon|quedo|quedaron)\b|\bolvidaste\b/,
    null,
    ['se te olvidó el import', 'olvidaste el caso vacío', 'se te pasó actualizar los tipos'],
    ['no se te olvide tomar agua jaja']),
  rule('es-no-hiciste', 'incomplete', 'es',
    /\bno (lo |la |los |las )?(hiciste|terminaste|completaste|implementaste|actualizaste|agregaste|anadiste|cambiaste|arreglaste|corregiste|subiste|incluiste|pusiste|quitaste)\b|\bquedo (a medias|incomplet[oa]|pendiente)\b|\b(esta|sigue) incomplet[oa]\b/,
    null,
    ['no hiciste el cambio en el header', 'no actualizaste los tests', 'quedó a medias', 'está incompleto'],
    ['no hice el café todavía']),
  rule('en-forgot', 'incomplete', 'en',
    /\byou (forgot|missed|skipped|left out|overlooked)\b/,
    null,
    ['you forgot the import', 'you missed the mobile layout', 'you skipped step 3'],
    ['I forgot to mention the deadline', "don't forget to smile"]),
  rule('en-missing', 'incomplete', 'en',
    /\byou (didn't|did not|never) (finish|implement|add|update|change|do|complete|include|fix|handle|remove|address)\b|\b(is|are|still) missing\b|\bnot (done|finished|complete) yet\b|\bhalf[- ]done\b|\bincomplete\b/,
    /\bwhat's missing\b|\bwhat is missing\b|\bif (anything|something) is missing\b/,
    ["you didn't update the README", 'the footer is still missing', 'this is incomplete', "it's not done yet"],
    ["what's missing?", 'if something is missing, tell me']),

  // ---- misunderstood ----
  rule('es-no-era-eso', 'misunderstood', 'es',
    /\bno (era|es) (eso|asi|lo que (te )?(pedi|dije|queria|quiero|necesito))\b|\beso no (es|era|fue) lo que\b|\bno fue lo que (te )?pedi\b|\bno (me )?entendiste\b|\b(me )?entendiste mal\b|\bme malentendiste\b|\basi no (es|era|va|lo quiero)\b|\bme referia (a|al)\b/,
    null,
    ['no era eso', 'eso no fue lo que pedí', 'no me entendiste', 'así no es', 'me refería al otro archivo'],
    ['no es para tanto, tranquilo']),
  rule('es-te-dije', 'misunderstood', 'es',
    /\bte (lo )?(dije|pedi|habia dicho|habia pedido|acabo de decir|explique)\b/,
    /\bcomo te (lo )?(dije|pedi|explique|habia dicho)\b|\bno te (lo )?pedi\b|\bsolo te pedi\b/,
    ['te dije que usaras TypeScript', 'ya te lo dije', 'te pedí que no cambiaras el color'],
    ['como te dije, el demo es el viernes']),
  rule('en-not-what-asked', 'misunderstood', 'en',
    /\bnot what i (asked|wanted|meant|said|requested|need)\b|\bi (didn't|did not) (mean|want) (that|this)\b|\b(you )?misunderstood\b|\bthat's not it\b|\bthat is not it\b|\bi meant\b/,
    null,
    ["that's not what I asked", "I didn't mean that", 'you misunderstood the task', 'I meant the other button'],
    ['this is exactly what I wanted']),
  rule('en-told-you', 'misunderstood', 'en',
    /\bi (already )?(told|asked) you\b|\blike i said\b|\bas i (already )?(said|told you)\b|\bi said (to|not|that|it)\b|\bi just said\b/,
    null,
    ['I told you to use pnpm', 'like I said, keep the header', 'I already asked you for this', 'I said not to touch the API'],
    ['I told my team about the release', 'tell you what, take a break']),

  // ---- redo ----
  rule('es-otra-vez', 'redo', 'es',
    /\b(otra vez|de nuevo|nuevamente|una vez mas|rehazlo|rehacerlo|repitelo|desde cero|de cero)\b|\bhazlo bien\b|\bvuelve a (intentar|intentarlo|hacerlo|empezar)\b/,
    /\b(gracias|grax) (otra vez|de nuevo|nuevamente)\b|\b(otra vez|de nuevo|nuevamente),? gracias\b|\b(envia|enviame|enviamelo|enviamela|manda|mandame|mandamelo|pasame|pasamelo|comparte|compartelo|muestrame|muestramelo|dame|damelo|repiteme|dime|dimelo)\b.{0,40}\b(otra vez|de nuevo|nuevamente)\b/,
    ['hazlo otra vez', 'inténtalo de nuevo', 'rehazlo desde cero', 'hazlo bien esta vez'],
    ['otra vez gracias', 'gracias de nuevo por la ayuda', 'envíame nuevamente el link', 'pásame otra vez el resumen']),
  rule('es-revierte', 'redo', 'es',
    /\b(devuelvelo|devuelvela|devuelve (eso|los cambios|el cambio|todo|lo que hiciste)|revierte|reviertelo|reviertela|reversa|reversalo|deshaz|deshazlo|regresalo|regresa (eso|todo|los cambios)|dejalo como estaba|vuelvelo a como estaba)\b/,
    null,
    ['devuélvelo como estaba', 'revierte ese commit', 'deshaz los cambios del header', 'déjalo como estaba'],
    ['agrega un botón para deshacer', 'el cliente devuelve el pedido si llega tarde']),
  rule('en-try-again', 'redo', 'en',
    /\b(try|do) (it |that |this )?again\b|\bredo\b|\bstart over\b|\bfrom scratch\b|\bone more time\b|\bdo it (properly|right|correctly)\b/,
    null,
    ['try again', 'redo the chart', 'start over', 'do it properly this time'],
    ['thanks again!', 'once again, great job']),
  rule('en-revert', 'redo', 'en',
    /\b(revert|undo|roll ?back) (that|this|it|those|these|everything|all|your|the (change|changes|commit|last|edit|edits|migration))\b|^(please )?(revert|undo|roll ?back)\b|\b(put|change) it back\b/,
    null,
    ['revert that', 'undo the last change', 'please roll back the migration', 'put it back the way it was'],
    ['add an undo button to the editor']),

  // ---- scope ----
  rule('es-alcance', 'scope', 'es',
    /\bno (te )?(lo )?pedi (eso|esto|que)\b|\bno te lo pedi\b|\bsolo te pedi\b|\bno (toques|modifiques|cambies|edites|muevas|refactorices) (eso|esto|nada|mas|el|la|los|las|ese|esa|esos|esas|otro|otra|otros|otras)\b|\b(fuera del|te saliste del) alcance\b|\beso no hacia parte\b/,
    null,
    ['eso no te lo pedí', 'solo te pedí cambiar el título', 'no toques el backend', 'te saliste del alcance'],
    ['no te preocupes por el alcance todavía']),
  rule('en-scope', 'scope', 'en',
    /\bi (didn't|did not|never) ask(ed)? (you )?(to|for)\b|\b(don't|do not) (touch|change|modify|edit|refactor|rename|move)\b|\bonly (asked|wanted) (you )?(to|for)\b|\bout of scope\b|\bleave (it|that|this|the \w+) alone\b/,
    null,
    ["I didn't ask you to refactor that", "don't touch the API", 'I only asked for the title change', 'leave the CSS alone'],
    ['no problem', 'touch up the copy a bit']),

  // ---- process ----
  rule('es-sin-preguntar', 'process', 'es',
    /\bno .{0,60}\bsin (preguntar|preguntarme|avisar|avisarme|consultar|consultarme|mi permiso|permiso|mi ok|mi aprobacion)\b|\bpor ?que .{0,60}\bsin (preguntar|preguntarme|avisar|avisarme|consultar|consultarme|permiso|mi permiso)\b|\b(preguntame|avisame|consultame) (antes|primero)\b/,
    null,
    ['no hagas push sin preguntar', 'no instales nada sin avisarme', 'pregúntame antes de borrar archivos', '¿por qué hiciste deploy sin preguntarme?'],
    ['hazlo sin preguntar, tienes permiso', 'avísame cuando termines']),
  rule('es-no-verificaste', 'process', 'es',
    /\bno (lo |la )?(verificaste|probaste|testeaste|revisaste|comprobaste|validaste|corriste)\b|\bsin (probar|probarlo|verificar|verificarlo|testear)\b|\b(verifica|verificalo|prueba|pruebalo|testealo|revisalo) (antes|primero) de\b/,
    null,
    ['no verificaste nada', 'no lo probaste', 'no subas cosas sin probar', 'pruébalo antes de decir que está listo'],
    ['prueba el endpoint de staging cuando puedas']),
  rule('en-ask-first', 'process', 'en',
    /\b(ask|check with|tell) me (first|before)\b|\bwithout (asking|telling|checking with|consulting) me\b|\bwithout (my )?(permission|approval)\b|\b(don't|do not) (commit|push|deploy|install|delete|merge|publish) (anything )?(without|until|before)\b/,
    /\b(feel free|go ahead|you can|you may)\b.{0,40}\bwithout asking\b/,
    ['ask me first', "don't push without asking", 'why did you deploy without telling me?', 'you merged without my approval'],
    ['feel free to proceed without asking me', 'tell me when you finish']),
  rule('en-didnt-test', 'process', 'en',
    /\byou (didn't|did not|never) (test|verify|check|run|try|build)\b|\b(test|verify|check) (it|that|this|them|your work|your changes) (before|first)\b|\bdid you even (test|run|verify|check|try)\b|\bwithout (testing|verifying|checking|running)\b/,
    null,
    ["you didn't test it", 'verify it before saying it works', 'did you even run the tests?', 'you pushed without testing'],
    ['please run the tests when you are ready', 'did you check the logs?']),

  // ---- language-style ----
  rule('es-idioma', 'language-style', 'es',
    /\b(en|al) (espanol|ingles)\b|\b(responde|respondeme|contesta|contestame|escribe|escribeme|hablame) (en )?(espanol|ingles)\b/,
    /\btraduc|\bya esta en (espanol|ingles)\b|\b(en|al) (espanol|ingles) (para|tambien)\b|\b(version|copia|tambien|otra|otro|uno|una) (en|al) (espanol|ingles)\b/,
    ['en español por favor', 'respóndeme en inglés', 'escribe la UI en español'],
    ['traduce el README al inglés', 'el texto ya está en español, gracias', 'hazme el mismo mensaje en inglés para Mario', 'una versión en inglés del correo']),
  rule('es-voseo', 'language-style', 'es',
    /\bvoseo\b|\bvose(es|aste|ando|ar)\b|\bno (uses|me hables de|hables de|me trates de|escribas con|escribas de) vos\b|\btuteame\b|\b(con|de) tu,? no (con|de) vos\b/,
    null,
    ['sin voseo, por favor', 'no uses vos, usa tú', 'estás voseando en la UI'],
    ['gracias, vos sos un crack']),
  rule('en-language', 'language-style', 'en',
    /\b(in|use) (english|spanish)\b/,
    /\btranslat/,
    ['in English please', 'reply in Spanish', 'use English for the UI copy'],
    ['translate this paragraph into Spanish']),
];

// First matching rule by priority, or null.
export function matchRule(text, rules = RULES) {
  for (const candidate of rules) if (candidate.test(text)) return candidate;
  return null;
}

// Human prompts eligible for correction detection: kind 'prompt', after the first
// prompt of the chat, opening or interrupting a turn > 0. Returns message indexes.
export function followUpPrompts(record) {
  const messages = record?.userMessages ?? [];
  const first = messages.findIndex(m => m.kind === 'prompt');
  const out = [];
  if (first < 0) return out;
  for (let i = first + 1; i < messages.length; i += 1) if (messages[i].kind === 'prompt' && messages[i].turn > 0) out.push(i);
  return out;
}

/**
 * Deterministic corrections: one item per follow-up human prompt (the first rule
 * by priority wins). Text is already redacted by E1; excerpts are ≤ 160 chars.
 * @returns {{turn:number, category:string, rule:string, source:'rule', excerpt:string}[]}
 */
export function detectCorrections(record, rules = RULES) {
  const items = [];
  for (const index of followUpPrompts(record)) {
    const message = record.userMessages[index];
    const hit = matchRule(ownWords(message.text), rules);
    if (hit) items.push({ turn: message.turn, category: hit.category, rule: hit.id, source: 'rule', excerpt: excerpt(message.text) });
  }
  return items;
}

// ---- closure claims ----

const CLAIM = /\b(listo|lista|listos|quedo|quedaron|termine|terminado|terminada|ya esta|ya quedo|hecho|completado|completada|implementado|implementada|verificado|verificada|commiteado|pusheado|done|completed|finished|implemented|fixed|verified|committed|pushed|deployed|works now|is working|all (tests|checks) pass(ed|es)?|(tests|checks|build) (now )?pass(ed|es)?|pasan (todos )?los (tests|checks)|todo en verde)\b|✅/g;
const NOT_CLAIM_AFTER = /^\s*(pendiente|a medias|incomplet|roto|mal|de que|yet|soon|later|when|once|after you)\b/;
const NEGATION = /\b(no|not|isn't|aren't|wasn't|haven't|hasn't|didn't|don't|doesn't|won't|nothing|never|nunca|todavia|aun|ni)\s+(\S+\s+){0,2}$/;
const CONDITIONAL = /\b(if|once|when|until|before|as soon as|after you|will|i'll|we'll|it'll|going to|should|would|could|si|cuando|una vez|hasta que|antes de|voy a|vamos a|va a|deberia|podria)\s+(\S+\s+){0,6}$/;

function clauseBefore(sentence, index) {
  const prefix = sentence.slice(0, index);
  const cut = Math.max(prefix.lastIndexOf(','), prefix.lastIndexOf(';'), prefix.lastIndexOf(' but '), prefix.lastIndexOf(' pero '));
  return cut >= 0 ? prefix.slice(cut + 1) : prefix;
}

/**
 * True when an agent's final text declares the work finished or verified
 * (ES/EN: listo, quedó, terminé, ya está, hecho, done, completed, finished,
 * all tests pass, verified, ✅ …). Questions, negated claims ("no está listo",
 * "not done yet") and conditional/future claims ("once tests pass") are rejected.
 */
export function isDoneClaim(text) {
  const normalized = normalize(text);
  if (!normalized) return false;
  const sentences = normalized.split(/(?<=[.!?\n])\s+/);
  for (const sentence of sentences) {
    if (/\?\s*$/.test(sentence)) continue;
    for (const match of sentence.matchAll(CLAIM)) {
      const before = clauseBefore(sentence, match.index);
      const after = sentence.slice(match.index + match[0].length);
      if (NEGATION.test(before) || CONDITIONAL.test(before) || NOT_CLAIM_AFTER.test(after)) continue;
      if (match[0] === 'hecho' && /\b(de|el|un|al|del)\s+$/.test(before)) continue;
      return true;
    }
  }
  return false;
}
