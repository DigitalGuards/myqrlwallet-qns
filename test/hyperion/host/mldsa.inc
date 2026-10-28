// SPDX-License-Identifier: GPL-3.0-or-later
// Test-only replacement for the hyptest ML-DSA-87 slot 3 fixture.
//
// scripts/lib/qrvm-host.js splices this definition into a worktree copy of the
// pinned test/QRVMHost.cpp. The host forwards the complete raw precompile input
// to a local verifier process (scripts/lib/mldsa-host.js, @theqrl/mldsa87) over
// the Unix socket named by QNS_MLDSA_SOCKET, framed by a 4-byte big-endian
// length. A valid signature returns the 64-byte word 1. QNS_MLDSA_FAILURE_FORM
// selects the failure candidate: "empty" (default) returns no data and "zero"
// returns a 64-byte zero word. Transport failures abort the process, so a
// negative vector can never pass because the verifier was unavailable.
qrvmc::Result QRVMHost::precompileMLDSA87Verify(qrvmc_message const& _message) noexcept
{
	auto const fail = [](char const* _reason) {
		std::cerr << "QNS ML-DSA-87 adapter failure: " << _reason << std::endl;
		std::abort();
	};
	char const* socketPath = std::getenv("QNS_MLDSA_SOCKET");
	sockaddr_un endpoint{};
	endpoint.sun_family = AF_UNIX;
	if (!socketPath || std::strlen(socketPath) >= sizeof(endpoint.sun_path))
		fail("QNS_MLDSA_SOCKET is unset or too long");
	std::strcpy(endpoint.sun_path, socketPath);
	int const fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
	if (fd < 0 || ::connect(fd, reinterpret_cast<sockaddr const*>(&endpoint), sizeof(endpoint)) != 0)
		fail("cannot connect to the verifier");
	auto const sendAll = [&](uint8_t const* _data, size_t _size) {
		while (_size > 0)
		{
			ssize_t const sent = ::write(fd, _data, _size);
			if (sent <= 0)
				fail("write failed");
			_data += sent;
			_size -= static_cast<size_t>(sent);
		}
	};
	size_t const inputSize = _message.input_size;
	if (inputSize > 0xffffffffu)
		fail("input too large");
	uint8_t const header[4]{
		static_cast<uint8_t>(inputSize >> 24),
		static_cast<uint8_t>(inputSize >> 16),
		static_cast<uint8_t>(inputSize >> 8),
		static_cast<uint8_t>(inputSize)
	};
	sendAll(header, sizeof(header));
	if (inputSize > 0)
		sendAll(_message.input_data, inputSize);
	uint8_t verdict = 2;
	if (::read(fd, &verdict, 1) != 1 || verdict > 1)
		fail("missing verdict");
	::close(fd);

	char const* failureForm = std::getenv("QNS_MLDSA_FAILURE_FORM");
	bool const zeroWordFailure = failureForm && std::strcmp(failureForm, "zero") == 0;
	static bytes result;
	result.assign(verdict || zeroWordFailure ? 64 : 0, 0);
	if (verdict)
		result.back() = 1;
	return resultWithGas(_message.gas, 125000, result);
}
