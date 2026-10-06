import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

// Regression test for finding S3. scripts/check-no-secrets.mjs is a
// post-hoc grep over build artifacts and structurally cannot see a secret
// serialised into the per-request RSC flight payload (a Server Component
// reading process.env and passing it as a prop to a Client Component never
// touches disk on a dynamically rendered route). The eslint.config.mjs rule
// added for this finding is the only control that can catch it, at compile
// time, so this test exercises the rule directly via ESLint's API rather
// than needing a real file under app/ or components/.

const VIOLATION_SOURCE = `
export default function Leaky() {
  return <ClientComp secret={process.env.SUPABASE_SERVICE_ROLE_KEY} />;
}
`;

// Finding S3 residual: the reviewer found two more direct, syntactic shapes
// the original single selector missed.
const SPREAD_VIOLATION_SOURCE = `
export default function Leaky() {
  return <ClientComp {...process.env} />;
}
`;

const CHILD_VIOLATION_SOURCE = `
export default function Leaky() {
  return <ClientComp>{process.env.SUPABASE_SERVICE_ROLE_KEY}</ClientComp>;
}
`;

const SAFE_SOURCE = `
export default function Safe() {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return <ClientComp label={secret ? 'has-secret' : 'no-secret'} />;
}
`;

function restrictedSyntaxMessages(messages: { ruleId: string | null; message: string }[]) {
  return messages.filter((m) => m.ruleId === 'no-restricted-syntax');
}

describe('eslint no-restricted-syntax: process.env in a JSX prop (finding S3)', () => {
  it('flags process.env passed directly as a JSX prop in app/', async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(VIOLATION_SOURCE, { filePath: 'app/leak-fixture.tsx' });
    const hits = restrictedSyntaxMessages(result.messages);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].message).toContain('RSC payload');
  });

  it('flags process.env passed directly as a JSX prop in components/', async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(VIOLATION_SOURCE, { filePath: 'components/LeakFixture.tsx' });
    const hits = restrictedSyntaxMessages(result.messages);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('flags process.env spread directly into a JSX prop (finding S3 residual)', async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(SPREAD_VIOLATION_SOURCE, { filePath: 'app/leak-fixture.tsx' });
    const hits = restrictedSyntaxMessages(result.messages);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].message).toContain('RSC payload');
  });

  it('flags process.env rendered directly as a JSX child (finding S3 residual)', async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(CHILD_VIOLATION_SOURCE, { filePath: 'app/leak-fixture.tsx' });
    const hits = restrictedSyntaxMessages(result.messages);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].message).toContain('RSC payload');
  });

  it('does not flag process.env one step removed from the JSX prop (a known limitation of a syntactic, non-data-flow rule)', async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(SAFE_SOURCE, { filePath: 'app/safe-fixture.tsx' });
    const hits = restrictedSyntaxMessages(result.messages);
    expect(hits).toHaveLength(0);
  });

  it('does not apply outside app/**/*.tsx and components/**/*.tsx', async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(VIOLATION_SOURCE, { filePath: 'lib/leak-fixture.tsx' });
    const hits = restrictedSyntaxMessages(result.messages);
    expect(hits).toHaveLength(0);
  });
});
