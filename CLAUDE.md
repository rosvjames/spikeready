# Instructions for Claude in this repo

SpikeReady: a copilot that gets small PayPal sellers ready for a sales spike (verified tracking, release calendar for held funds, invoice checks for limitation reviews). PayPal AI Hackathon, submission due Nov 11, 2026.

## Stack and commands
- TypeScript on Node 22 (ESM, `tsx` to run), Zod for validation, Vitest for tests, `@anthropic-ai/sdk` for invoice reading.
- `npm run typecheck`, `npm test` (must stay green), `npm run check | seed | tracking | hold | report | transactions`.
- CI: `.github/workflows/ci.yml` (typecheck + tests).

## Rules
- **AI reads and explains; code decides** and is the only thing that calls PayPal. No account action without the seller's approval.
- Never generate or edit seller documents; hash originals.
- Upload tracking only when the label destination matches the buyer's PayPal shipping address.
- Never suggest evading PayPal reviews.
- Secrets only in environment variables or a git-ignored `.env`. Never print them, log them or commit them. `.spikeready/` (local state) is git-ignored.
- Money in integer cents. Every PayPal write uses a deterministic `PayPal-Request-Id`.
- Tests never touch the network (inject a fake `fetch`).
- Code, comments, README and submission texts in **English**. Talk to the user in **Spanish**, in plain words.
- Commits are authored as **James Soto**. **No Claude attribution** of any kind in commits or PRs (no `Co-Authored-By` lines).
- Be honest about what is simulated (see the README table).

## Context
The research, decisions and roadmap live in the private vault repo `rosvjames/paypal-ai-hackathon-vault` (Spanish, Obsidian). Plan: `01 Hackathon/Roadmap hasta la entrega.md`. The invoice engine reuses `cut-tests/stockproof/` from that vault.
