import cloudflare from '@cloudflare/oxlint-config'
import landminesRecommended from '@interfere/landmines/configs/recommended.json' with { type: 'json' }
import { defineConfig } from 'oxlint'
import type { DummyRuleMap } from 'oxlint'

const landminesRules: DummyRuleMap = Object.fromEntries(
  Object.entries(landminesRecommended.rules).map(([rule, severity]) => [
    rule,
    severity === 'warn' ? 'warn' : severity === 'off' ? 'off' : 'error',
  ]),
)

const jsxA11yRules = {
  'jsx-a11y/alt-text': 'error',
  'jsx-a11y/anchor-has-content': 'error',
  'jsx-a11y/anchor-is-valid': 'error',
  'jsx-a11y/aria-activedescendant-has-tabindex': 'error',
  'jsx-a11y/aria-props': 'error',
  'jsx-a11y/aria-proptypes': 'error',
  'jsx-a11y/aria-role': 'error',
  'jsx-a11y/aria-unsupported-elements': 'error',
  'jsx-a11y/autocomplete-valid': 'error',
  'jsx-a11y/heading-has-content': 'error',
  'jsx-a11y/html-has-lang': 'error',
  'jsx-a11y/iframe-has-title': 'error',
  'jsx-a11y/img-redundant-alt': 'error',
  'jsx-a11y/interactive-supports-focus': 'error',
  'jsx-a11y/label-has-associated-control': 'error',
  'jsx-a11y/lang': 'error',
  'jsx-a11y/media-has-caption': 'error',
  'jsx-a11y/no-access-key': 'error',
  'jsx-a11y/no-aria-hidden-on-focusable': 'error',
  'jsx-a11y/no-distracting-elements': 'error',
  'jsx-a11y/no-interactive-element-to-noninteractive-role': 'error',
  'jsx-a11y/no-noninteractive-element-to-interactive-role': 'error',
  'jsx-a11y/no-noninteractive-tabindex': 'error',
  'jsx-a11y/no-redundant-roles': 'error',
  'jsx-a11y/role-has-required-aria-props': 'error',
  'jsx-a11y/role-supports-aria-props': 'error',
  'jsx-a11y/scope': 'error',
  'jsx-a11y/tabindex-no-positive': 'error',
} as const

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  ignorePatterns: [
    ...cloudflare.ignorePatterns,
    'dist/**',
    'dist-ssr/**',
    '.wrangler/**',
    '.cloudflare/**',
    '.taste-skill/**',
  ],
  jsPlugins: [...landminesRecommended.jsPlugins],
  rules: {
    ...jsxA11yRules,
    ...landminesRules,
    'landmines/no-comments': 'error',
    'react/only-export-components': ['error', { allowConstantExport: true }],
    'typescript/no-unsafe-type-assertion': 'off',
    'quality/no-chained-type-assertions': 'off',
    'quality/no-known-value-widening': 'off',
    'quality/no-unknown-returns': 'off',
    'quality/no-unsafe-dictionary-type': 'off',
  },
})
