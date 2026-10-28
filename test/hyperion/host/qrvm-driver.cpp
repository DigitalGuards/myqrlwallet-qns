// SPDX-License-Identifier: GPL-3.0-or-later
// Test-only QRVM driver for the QNS stateful fuzzer.
//
// It links the same patched hyptest QRVMHost that the semantic suites use
// (qrvmone loaded in process, reverted frames drop their logs) and executes a
// line protocol from standard input. Every value is lowercase hex without a
// prefix; "-" stands for empty data.
//
//   reset                          clear all accounts
//   snapshot | restore             save or restore every account
//   create <sender> <initcode>     R <status> <address> - <logs>, then one L line per log
//   call <sender> <to> <data>      R <status> - <output> <logs>, then one L line per log
//   view <sender> <to> <data>      V <status> <output>
//   viewlist <count>               define the observation list; count lines "<sender> <to> <data>" follow
//   observe                        O <sha256 over status byte, 4-byte length and output of every listed view>
//   observe-verbose                one V line per listed view
//
// A log line is "L <creator> <topic,topic,...|-> <data>". Transactions use the
// host's full call path. Views execute the target code directly in static mode,
// so they cannot change state and do not copy the account map.

#include <test/QRVMHost.h>

#include <libhyputil/CommonData.h>
#include <libhyputil/picosha2.h>

#include <cstdint>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>

using namespace hyperion;
using namespace hyperion::test;

namespace
{

int64_t const transactionGas = 100000000;

std::vector<uint8_t> parseData(std::string const& _hex)
{
	if (_hex == "-")
		return {};
	if (_hex.size() % 2 != 0)
		throw std::runtime_error("odd hex length");
	return util::fromHex(_hex, util::WhenError::Throw);
}

qrvmc::address parseAddress(std::string const& _hex)
{
	std::vector<uint8_t> const raw = parseData(_hex);
	if (raw.size() != sizeof(qrvmc::address::bytes))
		throw std::runtime_error("address must have 64 bytes");
	qrvmc::address address{};
	for (size_t i = 0; i < raw.size(); ++i)
		address.bytes[i] = raw[i];
	return address;
}

std::string hexOf(uint8_t const* _data, size_t _size)
{
	if (_size == 0)
		return "-";
	return util::toHex(std::vector<uint8_t>(_data, _data + _size));
}

std::string hexOf(qrvmc::address const& _address)
{
	return hexOf(_address.bytes, sizeof(_address.bytes));
}

std::string hexOf(qrvmc::bytes64 const& _word)
{
	return hexOf(_word.bytes, sizeof(_word.bytes));
}

void printLogs(QRVMHost const& _host)
{
	for (auto const& log: _host.recorded_logs)
	{
		std::cout << "L " << hexOf(log.creator) << ' ';
		if (log.topics.empty())
			std::cout << '-';
		for (size_t i = 0; i < log.topics.size(); ++i)
			std::cout << (i ? "," : "") << hexOf(log.topics[i]);
		std::cout << ' ' << hexOf(log.data.data(), log.data.size()) << '\n';
	}
}

struct View
{
	qrvmc::address sender;
	qrvmc::address target;
	std::vector<uint8_t> data;
};

std::tuple<int, std::vector<uint8_t>> executeView(QRVMHost& _host, qrvmc::VM& _vm, View const& _view)
{
	qrvmc_message message{};
	message.kind = QRVMC_CALL;
	message.flags = QRVMC_STATIC;
	message.depth = 0;
	message.gas = transactionGas;
	message.sender = _view.sender;
	message.recipient = _view.target;
	message.code_address = _view.target;
	message.input_data = _view.data.data();
	message.input_size = _view.data.size();
	auto const account = _host.accounts.find(_view.target);
	if (account == _host.accounts.end() || account->second.code.empty())
		return {static_cast<int>(QRVMC_SUCCESS), {}};
	qrvmc::bytes const code = account->second.code;
	qrvmc::Result result = _vm.execute(_host, QRVMC_ZOND, message, code.data(), code.size());
	return {
		static_cast<int>(result.status_code),
		std::vector<uint8_t>(result.output_data, result.output_data + result.output_size)
	};
}

}

int main(int argc, char** argv)
{
	if (argc != 2)
	{
		std::cerr << "usage: qns-qrvm-driver <libqrvmone>" << std::endl;
		return 2;
	}
	qrvmc::VM& vm = QRVMHost::getVM(argv[1]);
	if (!vm)
		return 2;
	QRVMHost host(langutil::QRVMVersion::zond(), vm);
	decltype(host.accounts) saved = host.accounts;
	std::vector<View> views;

	std::ios::sync_with_stdio(false);
	std::string line;
	while (std::getline(std::cin, line))
	{
		std::istringstream in(line);
		std::string command;
		in >> command;
		if (command.empty())
			continue;
		if (command == "reset")
		{
			host.reset();
			std::cout << "ok\n";
		}
		else if (command == "snapshot")
		{
			saved = host.accounts;
			std::cout << "ok\n";
		}
		else if (command == "restore")
		{
			host.accounts = saved;
			std::cout << "ok\n";
		}
		else if (command == "create" || command == "call")
		{
			bool const isCreate = command == "create";
			std::string senderHex, targetHex, dataHex;
			in >> senderHex;
			if (!isCreate)
				in >> targetHex;
			in >> dataHex;
			std::vector<uint8_t> const data = parseData(dataHex);
			host.newBlock();
			qrvmc_message message{};
			message.kind = isCreate ? QRVMC_CREATE : QRVMC_CALL;
			message.sender = parseAddress(senderHex);
			if (!isCreate)
			{
				message.recipient = parseAddress(targetHex);
				message.code_address = message.recipient;
			}
			message.gas = transactionGas;
			message.input_data = data.data();
			message.input_size = data.size();
			qrvmc::Result result = host.call(message);
			bool const created = isCreate && result.status_code == QRVMC_SUCCESS;
			// A successful creation returns the runtime code; it is not echoed.
			std::cout << "R " << static_cast<int>(result.status_code) << ' '
				<< (created ? hexOf(result.create_address) : "-") << ' '
				<< (created ? "-" : hexOf(result.output_data, result.output_size)) << ' '
				<< host.recorded_logs.size() << '\n';
			printLogs(host);
		}
		else if (command == "view")
		{
			std::string senderHex, targetHex, dataHex;
			in >> senderHex >> targetHex >> dataHex;
			View const view{parseAddress(senderHex), parseAddress(targetHex), parseData(dataHex)};
			auto const [status, output] = executeView(host, vm, view);
			std::cout << "V " << status << ' ' << hexOf(output.data(), output.size()) << '\n';
		}
		else if (command == "viewlist")
		{
			size_t count = 0;
			in >> count;
			views.clear();
			for (size_t i = 0; i < count; ++i)
			{
				if (!std::getline(std::cin, line))
					throw std::runtime_error("truncated view list");
				std::istringstream viewLine(line);
				std::string senderHex, targetHex, dataHex;
				viewLine >> senderHex >> targetHex >> dataHex;
				views.push_back({parseAddress(senderHex), parseAddress(targetHex), parseData(dataHex)});
			}
			std::cout << "ok " << views.size() << '\n';
		}
		else if (command == "observe" || command == "observe-verbose")
		{
			bool const verbose = command == "observe-verbose";
			std::vector<uint8_t> transcript;
			for (View const& view: views)
			{
				auto const [status, output] = executeView(host, vm, view);
				if (verbose)
					std::cout << "V " << status << ' ' << hexOf(output.data(), output.size()) << '\n';
				transcript.push_back(static_cast<uint8_t>(status));
				for (int shift = 24; shift >= 0; shift -= 8)
					transcript.push_back(static_cast<uint8_t>(output.size() >> shift));
				transcript.insert(transcript.end(), output.begin(), output.end());
			}
			if (!verbose)
				std::cout << "O " << picosha2::hash256_hex_string(transcript) << '\n';
		}
		else
		{
			std::cerr << "unknown command: " << command << std::endl;
			return 2;
		}
		std::cout.flush();
	}
	return 0;
}
