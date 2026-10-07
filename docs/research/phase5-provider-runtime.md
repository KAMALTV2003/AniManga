# Phase 5 provider and durable-runtime research

**Reviewed:** 2026-10-07

**Scope:** official provider and durable-execution documentation used to define the Phase 5 contracts

## Sources

- Anthropic Claude Platform: Messages streaming, API errors, rate limits, and stop-reason handling
  - <https://docs.anthropic.com/en/api/messages-streaming>
  - <https://docs.anthropic.com/en/api/errors>
  - <https://docs.anthropic.com/en/api/rate-limits>
  - <https://docs.anthropic.com/en/api/handling-stop-reasons>
- OpenAI Platform: Responses and streaming API reference
  - <https://platform.openai.com/docs/api-reference/responses>
  - <https://platform.openai.com/docs/api-reference/streaming>
- Google Gemini API: current Google GenAI SDK migration, text generation, function calling, and structured output
  - <https://ai.google.dev/gemini-api/docs/migrate>
  - <https://ai.google.dev/gemini-api/docs/generate-content/text-generation>
  - <https://ai.google.dev/gemini-api/docs/generate-content/structured-output>
- Temporal: durable execution, event history/replay, and TypeScript workflow determinism
  - <https://docs.temporal.io/evaluate/understanding-temporal>
  - <https://docs.temporal.io/encyclopedia/event-history/event-history-typescript>
  - <https://docs.temporal.io/develop/typescript/integrations/ai-sdk>

## Findings reflected in the implementation

1. Provider success, truncation/stop reasons, transport errors, stream errors, rate limits, and spend-limit errors are distinct states. The NEXUS contract does not collapse all of them into generated text.
2. Provider streaming protocols expose different event taxonomies. The current port normalizes complete responses first; future streaming adapters must retain typed lifecycle events and must not expose partial output as policy-approved output.
3. Tool/function calling differs by provider and API mode. The Phase 5 foundation records `tool_call` as a stop reason but deliberately provides no tool executor. Tool execution remains blocked until the Phase 7 policy, approval, and sandbox boundary.
4. Usage and cost evidence must be explicit. The gateway requires normalized token usage, while cost may remain `null` when a provider cannot supply or the caller cannot calculate it honestly.
5. Provider model names and feature availability change independently of NEXUS. The registry stores provider/model identities and declared capabilities as data; routing contains no hardcoded vendor model preference.
6. Retries must be based on normalized error class, idempotency, retry-after information, budget, and provider semantics. This milestone does not silently retry model calls.
7. Durable workflow code must remain deterministic; LLM calls, network I/O, files, and tools belong in recorded activities. Temporal's event-history/replay model is the selected production direction. No durable-execution claim is made until replay, worker-crash, idempotency, and upgrade tests exist.
8. A real-provider conformance run can incur cost and transmit the fixed probe to the provider. NEXUS exposes the harness but does not run external providers without explicit operator configuration.

## Deliberate exclusions

- No SDK is installed merely to advertise provider compatibility.
- No provider credential is read, persisted, printed, or embedded by the canonical package.
- No simulated provider result is used as product evidence. Deterministic providers exist only inside tests to verify the contract.
- No model output can activate an agent, change policy, execute a tool, or promote memory.
