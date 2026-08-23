# QRL 2.0 address model

Status: implemented for the 64-byte development network on 2026-08-22.

## Verified upstream model

Current go-qrl defines `common.AddressLength = 64`. Current Hyperion defines `VMWordBytes = 64`, `AddressBits = 512`, and `AddressBytes = 64`. The ABI encoder gives `address` one 64-byte slot.

The legacy Testnet V2 model used 20-byte execution addresses and a separate 24-byte resolver record. Those records and deployments do not carry into the QRL 2.0 genesis.

## QNS decision

QNS uses one native address record:

```text
addr(bytes32 node) returns (address)
```

`QRLPublicResolver` stores the native `address` directly. The legacy `qrlAddr(bytes32) returns (bytes)` profile and its 24-byte length rule were removed.

## ABI layout

- Every static argument occupies 64 bytes.
- An `address` uses the complete 64-byte slot.
- A `bytes32` value is left-aligned in its slot and followed by 32 zero bytes.
- Dynamic offsets and lengths are encoded as 64-byte words.

The SDK mirrors these rules without relying on Ethereum ABI libraries that assume 32-byte words.

## Reverse labels

For a text address `Q<128 hex>`, QNS removes the prefix, lowercases the 128 hex characters, encodes them as ASCII, and computes Keccak-256. The result is the labelhash below `addr.reverse`.

```text
labelhash = keccak256(ascii(lowercase(address_hex_128)))
node = keccak256(namehash("addr.reverse") || labelhash)
```

The contract and SDK implement the same algorithm. This is a width-adjusted ENSIP-19 construction and requires a fresh reverse namespace on the new chain.

## Compatibility boundary

Function signatures such as `addr(bytes32)` keep their canonical selector text. Calldata and return encoding use QRL's 64-byte ABI. Ethereum clients with a fixed 32-byte ABI codec cannot call QRL 2.0 contracts directly.
