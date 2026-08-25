# Vendored Hyperion contracts

This directory contains the Hyperion-native QNS copies of selected ENS v1 contracts plus a minimal in-tree OpenZeppelin subset.

## ENS pin

```text
repository: ensdomains/ens-contracts
tag: v1.6.2
commit: 3d477d4
date: 2025-12-08
```

The selected registry, resolver-profile, root, and reverse-registrar files retain their upstream MIT license. See `LICENSE` and `DIFFS.md`.

## Included scope

- `registry/`: the QNS registry interface (`IQNSRegistry`) and implementation (`QNSRegistry`), ported from the ENS v1 registry.
- `root/`: root ownership and controller management.
- `resolvers/`: resolver base and the address, text, contenthash, name, and version interfaces.
- `reverseRegistrar/`: basic transaction-sender reverse registration.
- `openzeppelin/`: minimal Ownable and ERC-165 implementations used by this tree.

QNS-specific contracts live outside `vendored/`. NameWrapper, auction registration, DNS, Universal Resolver, and CCIP Read are outside the current scope.

## Update policy

Keep upstream-derived behavior stable, record every semantic change in `DIFFS.md`, and re-run the complete Hyperion contract build after changing the pin or compiler version.
