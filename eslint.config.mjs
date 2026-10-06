import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['scripts/generate-icons.mjs', 'public/sw.js'],
  },
  {
    // A secret read from process.env in a Server Component and passed as a
    // prop to a Client Component is serialised into the per-request RSC
    // flight payload and streamed to the browser. That payload never
    // touches disk on a dynamically rendered route, so
    // scripts/check-no-secrets.mjs -- a post-hoc grep over build artifacts
    // -- structurally cannot see it (finding S3). This is a compile-time
    // control for the same class of leak; keep the runtime scan as a
    // second layer, not a replacement.
    //
    // Three selectors, three JSX shapes that all reach the RSC payload the
    // same way:
    //   <C prop={process.env.K} />     JSXAttribute > JSXExpressionContainer
    //   <C {...process.env} />         JSXSpreadAttribute (no ExpressionContainer)
    //   <C>{process.env.K}</C>         JSXElement child > JSXExpressionContainer
    //
    // Known limitation, documented rather than silently accepted (finding
    // S3 residual): this rule is syntactic (an AST selector match), not a
    // data-flow analysis. It cannot see an indirection through a local:
    //   const s = process.env.X; return <C prop={s} />;
    // is not caught, even though it leaks the same value. `server-only` is
    // the real control against that shape -- every module in this repo that
    // touches a secret imports it, so pulling one into a Client Component
    // is a hard build failure, not a lint warning this rule would have to
    // catch. See .pipeline/final-review.md section 2, finding S3, for the
    // fuller residual-risk argument.
    files: ['app/**/*.tsx', 'components/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXAttribute > JSXExpressionContainer MemberExpression[object.object.name='process'][object.property.name='env']",
          message:
            'Never pass process.env into a JSX prop. It is serialised into the RSC payload and shipped to the browser.',
        },
        {
          selector: "JSXSpreadAttribute MemberExpression[object.name='process'][property.name='env']",
          message:
            'Never spread process.env into a JSX prop. It is serialised into the RSC payload and shipped to the browser.',
        },
        {
          selector:
            "JSXElement > JSXExpressionContainer MemberExpression[object.object.name='process'][object.property.name='env']",
          message:
            'Never render process.env in JSX. It is serialised into the RSC payload and shipped to the browser.',
        },
      ],
    },
  },
];

export default eslintConfig;
