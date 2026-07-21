// The public SDK surface is defined in `src/contract/`. Importing from
// here (rather than from the implementation files directly) is what
// makes Layer A of the equivalence strategy enforceable — the contract
// barrel IS the locked surface. See
// cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
// §5.2.
export * from "./contract/index.js";
