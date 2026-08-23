# Recon and threat model

## Scope

- go-qrl slots 3 and 6, gas calculation, raw input parsing, output encoding, and registration
- Hyperion parsing, types, legacy lowering, via-IR lowering, formal encoding, and QRVM host support for `shake256` and `mldsa87verify`
- QNS verifier, resolver capability policy, 64-byte reverse labels, SDK parity, guarded local deployment, and Kurtosis integration
- draft QIP security and activation requirements

## Entry points

- arbitrary calls to the raw precompile addresses
- `QRLSignatureVerifier.digest`, `verifyDigest`, and `verify`
- resolver setters and `clearRecords`
- reverse registrar claims and name writes
- deployment secret selection and local public fixture selection
- compiler builtin calls in legacy and via-IR output

## Trust boundaries

- contract caller to QRVM
- QRVM to go-qrl precompile host
- Hyperion source to legacy and via-IR bytecode
- QNS resolver to ENS owner state
- JavaScript SDK to contract ABI
- local deployment scripts to wallet material
- execution client to Qrysm through the Engine API

## Attacker capabilities

The attacker controls all call data and all public function parameters. The attacker can submit malformed lengths, arbitrary cryptographic material, maximum contexts, unauthorized resolver writes, crafted 64-byte addresses, and repeated expensive calls. The attacker may know every prefunded Kurtosis fixture.

## Security invariants

- new precompile behavior activates only under the agreed consensus rule
- SHAKE256 returns exactly 64 deterministic bytes with overflow-safe gas calculation
- ML-DSA-87 accepts only the specified packed length range and returns a canonical 64-byte boolean word
- QNS verification applies the exact 64-byte boundary and the versioned context
- supplied public keys gain no identity authority without a separate binding rule
- resolver owner-only records change only for the current node owner
- trusted reverse registrar capability reaches `setName` only
- reverse labels consume all 64 address bytes as 128 lowercase hexadecimal characters
- local public fixtures are selected only for the exact loopback development chain
