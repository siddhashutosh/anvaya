# @anvaya/core

Shared domain vocabulary for **[Anvaya](https://github.com/siddhashutosh/anvaya)** — AI
failure observability. Types, the failure taxonomy, error classes, logging and redaction.

```bash
npm install @anvaya/core
```

Requires Node.js ≥ 20.

Most users do not install this directly — it arrives as a dependency of
[`@anvaya/sdk`](https://www.npmjs.com/package/@anvaya/sdk). Install it on its own if you
want the taxonomy as data, or if you are building your own producer against the ingest
contract.

## The failure taxonomy

**57 named failure modes across 8 families**, covering all 14
[MAST](https://arxiv.org/abs/2503.13657) modes, all 7
[Barnett et al.](https://arxiv.org/pdf/2401.05856) RAG failure points, and 6
[OWASP LLM Top 10 (2025)](https://genai.owasp.org/llm-top-10/) entries.

```ts
import { CATALOG, getMode, requireMode, byFamily, isCausedBy } from '@anvaya/core';

requireMode('RET-002');
// { code: 'RET-002', name: 'Retrieval quality collapse', family: 'RET',
//   tier: 'L2', causes: ['GEN-004', 'GEN-008', ...], ... }

isCausedBy('GEN-004', 'RET-002');   // true — the hallucination is a symptom
```

| Family | Modes | Concern |
|---|---|---|
| `INF` | 6 | The plumbing broke |
| `CTX` | 5 | What went into the model was wrong |
| `RET` | 7 | The facts never arrived |
| `GEN` | 8 | The model produced a bad answer |
| `AGT` | 12 | The control flow went wrong |
| `TOL` | 6 | The action layer failed |
| `SEC` | 6 | Somebody is being harmed or attacked |
| `ECO` | 6 | It is getting worse or more expensive |

The `causes` edges are what make causal attribution possible: a bad answer points at the
retrieval step that caused it rather than at itself.

## Licence

Apache-2.0 — see [LICENSE](./LICENSE).
