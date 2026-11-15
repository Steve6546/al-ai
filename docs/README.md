# Documentation index

| Document | Read it when |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | you need the process diagram, data-flow rules, module map or the current decomposition status of the large modules |
| [API.md](API.md) | you add or change a Fastify route, a guard, a Discord REST call, or an error status |
| [DEPLOYMENT.md](DEPLOYMENT.md) | you run or deploy the stack: environment reference, ports, single-instance guards, ngrok quota, verification and troubleshooting |
| [GOVERNANCE.md](GOVERNANCE.md) | you change a rule. Exactly **29** numbered rules, enforced by `apps/bot/test/governance.test.ts` — do not renumber, merge or de-bold one without updating that test |
| [SECURITY-AUDIT.md](SECURITY-AUDIT.md) | you need the full security audit: scope inspected, findings, applied fixes (secrets/env/Git/auth/2FA), measured verification results, and open decisions |
| [BOOK.md](BOOK.md) | the illustrated operator guide (Arabic), with screenshots from `docs/images/` |
| [BOT-HOSTING-MCP.md](BOT-HOSTING-MCP.md) | managed hosting evaluation (accepted path) |

## Historical / evaluation documents

These are point-in-time records, not active contracts:

- [HANDOVER-VERIFICATION-2026-11-05.md](HANDOVER-VERIFICATION-2026-11-05.md) — dated handover and verification snapshot.
- [FEATHERPANEL-MCP.md](FEATHERPANEL-MCP.md) — rejected hosting evaluation, superseded by BOT-HOSTING-MCP.md.
- [DEPLOY.md](DEPLOY.md) — a blocked deployment attempt; the active deployment guide is DEPLOYMENT.md.

Nothing in this directory is generated at build time. Operational rules that
must survive across sessions also live in `.workbuddy-ai/memory/RULES-*.md`
(tracked project knowledge, not scratch files).
