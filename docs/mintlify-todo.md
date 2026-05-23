# Mintlify Documentation Site — Setup TODO

V1.5 Phase 11 plan included full Mintlify documentation site with API reference auto-generation, video tutorials, and multi-locale (en + vi) support. **Not implemented in this session** because:

- Video production requires real screen recording + editing (1-2 hours per video, not achievable via code-only session)
- Multi-locale i18n requires Vietnamese translation of all docs (~3000 words × 2 locales)
- Mintlify hosted site requires deploy credentials + custom domain setup

## Manual setup steps (when ready)

1. **Sign up Mintlify**: https://mintlify.com — connect GitHub repo `xeko-git-1/paykit`
2. **Initialize**: `npx mintlify init` in repo root → creates `mint.json`
3. **Configure mint.json**:
```json
{
  "name": "Paykit",
  "logo": { "light": "/logo-light.svg", "dark": "/logo-dark.svg" },
  "navigation": [
    {
      "group": "Getting Started",
      "pages": ["docs/installation", "docs/upgrading-v1-to-v1.5"]
    },
    {
      "group": "Provider Setup",
      "pages": [
        "docs/sandbox-setup-vnpay",
        "docs/sandbox-setup-momo",
        "docs/sandbox-setup-zalopay"
      ]
    },
    {
      "group": "Reference",
      "pages": ["docs/refund-flows", "docs/mobile-integration", "docs/deeplink-formats"]
    }
  ],
  "anchors": [
    { "name": "GitHub", "url": "https://github.com/xeko-git-1/paykit", "icon": "github" }
  ]
}
```

4. **API reference auto-gen**: TypeDoc → MDX
```bash
pnpm add -D typedoc typedoc-plugin-markdown
npx typedoc --out docs/api packages/*/src
```

5. **Multi-locale**: Mintlify natively supports per-page `locale` field. Create `docs/vi/` mirror with translated copies (estimate 1 week translator effort).

6. **Videos**: Record 5 short videos (3-5 min each):
   - "What is paykit?"
   - "Install + first checkout (Stripe)"
   - "Add VNPay/Momo/ZaloPay"
   - "Refund flow"
   - "Reconciliation worker"

7. **Custom domain**: `paykit.dev` (purchase + DNS setup at registrar; Mintlify adds SSL).

## V1.5 GA gate

V1.5 GA does NOT require Mintlify site live. Markdown docs in `docs/` directory + README link to GitHub Pages-served version is sufficient.

When Mintlify ready → V1.6 release.
