// Redaction: every secret/personal-data kind is replaced, ordinary text is kept,
// and each pattern is load-bearing (disabling it breaks its own positive case).
// Secret-like samples are assembled from pieces so this file holds no literal token,
// and assertion messages never include sample values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PATTERNS, createRedactor, redact } from '../evals/redact.mjs';

const POSITIVES = {
  'private-key': ['-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----', 'MIIBOgIBAAJBAKj34'],
  'url-credentials': ['connect to postgres://admin:' + 'Sup3rS3cret' + '@db.example.com:5432/app', 'Sup3rS3cret'],
  jwt: ['token eyJ' + 'hbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'dozjgNryP4J3jVmNHl0w5N'],
  'anthropic-key': ['key sk-' + 'ant-api03-' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z', 'Ab3dEf6hIj9kLm2nOp5q'],
  'openai-key': ['use sk-' + 'proj-' + 'Zq8Lm2Np4Rt6Vx9Bc1Df3Gh5Jk7 now', 'Zq8Lm2Np4Rt6Vx9Bc1Df3'],
  'github-token': ['gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', 'A1b2C3d4E5f6G7h8I9j0'],
  'slack-token': ['xo' + 'xb-' + '1234567890-0987654321-AbCdEfGhIjKl', '0987654321-AbCdEfGhIjKl'],
  'aws-key': ['AK' + 'IA' + 'Q3EGRIW7JX5ZPL2M', 'Q3EGRIW7JX5ZPL2M'],
  'google-key': ['AI' + 'za' + 'Sy' + 'A1b2C3d4E5'.repeat(4).slice(0, 33), 'A1b2C3d4E5A1b2C3'],
  'stripe-key': ['sk' + '_live_' + '4eC39HqLyjWDarjtT1zdp7dc', '4eC39HqLyjWDarjtT1zdp7dc'],
  'service-token': ['NEON=' + 'na' + 'pi_' + 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6', 'a1b2c3d4e5f6g7h8i9j0'],
  'auth-header': ['Authorization: Bearer ' + 'abcDEF1234567890ghiJKL', 'abcDEF1234567890ghiJKL'],
  assignment: ['password = "' + 'hunter2pass' + '"', 'hunter2pass'],
  email: ['escríbeme a ana.perez' + '@example.com mañana', 'ana.perez'],
  phone: ['call +44 20 ' + '7946 0958 today', '7946 0958'],
  'phone-co': ['llámame al 300 ' + '123 4567', '123 4567'],
  'digit-run': ['card 4111 1111 ' + '1111 1111', '1111 1111 1111'],
  'high-entropy': ['blob Zx9QwErTy7UiOp3' + 'AsDfGh5JkLzXc2VbNm8Qw end', 'AsDfGh5JkLzXc2VbNm8Qw'],
};
// The two phone patterns have separate positives (international first, Colombian second).
const sampleFor = index => {
  const { kind } = PATTERNS[index];
  if (kind === 'phone') return PATTERNS.slice(0, index).some(p => p.kind === 'phone') ? POSITIVES['phone-co'] : POSITIVES.phone;
  return POSITIVES[kind];
};

// Guard used by the positive test and the mutation test. Messages never echo values.
function assertRedacted(redactor, [sample, secret], kind) {
  const { text, count } = redactor(sample);
  assert.ok(text.includes(`[REDACTED:${kind}]`), `kind ${kind} produced no ${kind} marker`);
  assert.ok(!text.includes(secret), `kind ${kind} left its secret span in the text`);
  assert.ok(count >= 1, `kind ${kind} reported no replacement`);
}

test('every pattern kind has a positive sample and redacts it', () => {
  for (let i = 0; i < PATTERNS.length; i += 1) {
    const sample = sampleFor(i);
    assert.ok(sample, `pattern ${i} (${PATTERNS[i].kind}) has no positive sample`);
    assertRedacted(redact, sample, PATTERNS[i].kind);
  }
});

test('mutation: disabling any single pattern breaks its own positive case', () => {
  for (let i = 0; i < PATTERNS.length; i += 1) {
    const mutated = createRedactor(PATTERNS.filter((_, j) => j !== i));
    assert.throws(() => assertRedacted(mutated, sampleFor(i), PATTERNS[i].kind), assert.AssertionError,
      `pattern ${i} (${PATTERNS[i].kind}) is not load-bearing`);
  }
});

test('ordinary prose, SHAs, UUIDs, paths and code identifiers are untouched', () => {
  const negatives = [
    'Hola, arregla el bug del login y corre los tests por favor. ¿Funciona ya?',
    'Please review the password reset flow and the token refresh logic.',
    'commit a1b2c3d and a1b2c3d4e5f6 fixed it; full sha 0123456789abcdef0123456789abcdef01234567',
    'session 0f8c2a6e-1111-4222-8333-944455556666 resumed',
    'C:\\Users\\example\\Projects\\agent-relay\\server\\server.mjs',
    '/c/Users/example/Downloads/agent-work/agent-relay-missions/b3e6bca4-0467-4d7a-8fdb-74296b13ca78/tasks/extract/worktree',
    'web/src/components/dashboard/MissionPanel.tsx on branch relay/b3e6bca4-0467-4d7a-8fdb-74296b13ca78/extract',
    'const tokenCount = usage.output_tokens; max_tokens: 4096; const secret = process.env.SECRET_NAME;',
    'handleUserProfileUpdateForAccountSettings2 and RELAY_EVALS_HOME_DIRECTORY_OVERRIDE_V2',
    'at 2026-10-22T14:00:00.000Z with node v22.13.0, port 4848, ts 1729600000, version 1.2.3',
    'git clone git@github.com:example/agent-relay.git and npm i react@18.2.0',
    'Basic setup instructions and Bearer authentication are documented.',
  ];
  negatives.forEach((text, i) => {
    const result = redact(text);
    assert.equal(result.count, 0, `negative case ${i} was changed`);
    assert.equal(result.text, text, `negative case ${i} was changed`);
  });
});

test('count reports every replacement and non-strings are safe', () => {
  const text = `${POSITIVES.email[0]} and ${POSITIVES['openai-key'][0]} and ${POSITIVES['digit-run'][0]}`;
  const result = redact(text);
  assert.equal(result.count, 3);
  assert.deepEqual(redact(null), { text: '', count: 0 });
  assert.deepEqual(redact(undefined), { text: '', count: 0 });
});
