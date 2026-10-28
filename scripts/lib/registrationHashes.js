function registrationHashes(requestedLabel, configuredTld, sdk, web3) {
    const nameLabel = sdk.normalize(requestedLabel);
    const tld = sdk.normalize(configuredTld);
    if (!nameLabel || nameLabel.includes(".")) throw new Error("Registration requires one nonempty label");
    if (!tld || tld.includes(".")) throw new Error("Configured TLD requires one nonempty label");
    const fullName = sdk.normalize(`${nameLabel}.${tld}`);
    const labelHash = sdk.abi.hashText(nameLabel);
    const tldNode = sdk.nodeToHex(sdk.namehash(tld));
    const node = sdk.nodeToHex(sdk.namehash(fullName));

    // Independently check the web3 byte encoding before any signing or writes.
    const utf8Hash = (label) => web3.utils.keccak256(web3.utils.utf8ToHex(label));
    const checkedTld = web3.utils.keccak256(`0x${"00".repeat(32)}${utf8Hash(tld).slice(2)}`);
    const checkedNode = web3.utils.keccak256(checkedTld + utf8Hash(nameLabel).slice(2));
    if (labelHash !== utf8Hash(nameLabel) || tldNode !== checkedTld || node !== checkedNode) {
        throw new Error("SDK and web3 namehash disagree before registration");
    }
    return { nameLabel, fullName, labelHash, tldNode, node };
}

module.exports = { registrationHashes };
