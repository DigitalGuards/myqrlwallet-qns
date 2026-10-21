import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  readRegistrationState,
  registrationName,
  registrationPlan,
  registrationTransaction,
  reverseNodeFor,
  type TransactionStatus,
  type TransactionUpdate,
} from "@qns/sdk";
import { ACCOUNT, config, MockChain } from "../../sdk/src/__tests__/mockProvider";
import {
  ClaimProgress,
  ClaimSummary,
  claimSteps,
  stepDetails,
  transactionOutcomes,
} from "./ClaimProgress";

afterEach(cleanup);

it.each([false, true])("explains an empty search (connected=%s)", (connected) => {
  render(
    <ClaimSummary
      name=""
      config={config}
      primary={false}
      state={null}
      updates={[]}
      running={false}
      connected={connected}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe("Search for a name to see the steps.");
});

it.each([
  {
    connected: false,
    searching: false,
    searchError: null,
    expected: "Connect your wallet to see the approvals alice.qrl needs.",
  },
  ...[false, true].flatMap((connected) => [
    { connected, searching: true, searchError: null, expected: "Reading alice.qrl..." },
    {
      connected,
      searching: false,
      searchError: "Could not refresh name availability: Name lookup failed",
      expected: "Check the error below and search again.",
    },
  ]),
])("summarizes the name read: $expected (connected=$connected)", (props) => {
  render(
    <ClaimSummary
      name="alice.qrl"
      config={config}
      primary={false}
      state={null}
      updates={[]}
      running={false}
      connected={props.connected}
      searching={props.searching}
      searchError={props.searchError}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe(props.expected);
});

it.each([false, true])("preserves the approval count (primary=%s)", async (primary) => {
  const state = await readRegistrationState("alice", ACCOUNT, {
    config,
    provider: new MockChain(),
  });
  render(
    <ClaimSummary
      name="alice.qrl"
      config={config}
      primary={primary}
      state={state}
      updates={[]}
      running={false}
      connected
    />,
  );
  expect(screen.getByRole("status").textContent).toBe(
    `Set up alice.qrl: ${primary ? 5 : 4} wallet approvals remaining.`,
  );
});

const answers: TransactionStatus[] = ["confirmed", "failed"];
it.each(claimSteps.flatMap((step) => answers.map((answer) => ({ step, answer }))))(
  "keeps $step approval ahead of a complete snapshot and reconciles after $answer",
  async ({ step, answer }) => {
    const chain = new MockChain();
    const name = registrationName("alice");
    chain.seed(name.name, ACCOUNT);
    chain.resolvers.set(name.node, config.contracts.QRLPublicResolver ?? "");
    chain.addresses.set(name.node, ACCOUNT);
    chain.spellings.set(name.node, name.name);
    chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
    chain.primary = name.name;
    const complete = await readRegistrationState(name.name, ACCOUNT, { config, provider: chain });
    const updates: TransactionUpdate[] = [{ step, status: "approval" }];
    const props = { name: name.name, config, primary: true, state: null, running: true, updates };
    const view = render(
      <>
        <ClaimSummary {...props} />
        <ClaimProgress {...props} />
      </>,
    );
    view.rerender(
      <>
        <ClaimSummary {...props} state={complete} />
        <ClaimProgress {...props} state={complete} />
      </>,
    );
    const current = document.querySelector('[aria-current="step"]');
    if (!(current instanceof HTMLElement)) throw new Error("Missing approval step");
    const row = within(current);
    expect(row.getByText(stepDetails[step].title)).toBeDefined();
    expect(row.getByText("Approve in your wallet now")).toBeDefined();
    expect(row.queryByText("Skipped")).toBeNull();
    expect(
      row.getByTitle(registrationTransaction(name.name, ACCOUNT, step, config).to),
    ).toBeDefined();
    expect(row.getByText(stepDetails[step].function)).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe(
      "Claiming alice.qrl: 4 of 5 steps done, approve in your wallet now.",
    );

    view.rerender(
      <>
        <ClaimSummary
          {...props}
          state={complete}
          running={false}
          updates={[{ step, status: answer }]}
        />
        <ClaimProgress
          {...props}
          state={complete}
          running={false}
          updates={[{ step, status: answer }]}
        />
      </>,
    );
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "alice.qrl is ready. It resolves to your address and is your primary name.",
    );
    expect(row.getByText(answer === "confirmed" ? "Done" : "Skipped")).toBeDefined();
    expect(chain.sent).toHaveLength(0);
  },
);

const unsettled: TransactionStatus[] = ["pending", "unconfirmed", "failed"];
it.each(
  claimSteps.flatMap((step) =>
    unsettled.flatMap((status) => [false, true].map((running) => ({ step, status, running }))),
  ),
)(
  "preserves $step $status with a hash across complete snapshots (running=$running)",
  async ({ step, status, running }) => {
    const chain = new MockChain();
    const name = registrationName("alice");
    chain.seed(name.name, ACCOUNT);
    chain.resolvers.set(name.node, config.contracts.QRLPublicResolver ?? "");
    chain.addresses.set(name.node, ACCOUNT);
    chain.spellings.set(name.node, name.name);
    chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
    chain.primary = name.name;
    const complete = await readRegistrationState(name.name, ACCOUNT, { config, provider: chain });
    const update: TransactionUpdate = {
      step,
      status,
      hash: `0x${"d".repeat(64)}`,
      ...(status === "failed" ? { message: "Transaction reverted" } : {}),
    };
    const props = {
      name: name.name,
      config,
      primary: true,
      state: complete,
      running,
      updates: [update],
    };
    const view = render(
      <>
        <ClaimSummary {...props} />
        <ClaimProgress {...props} />
      </>,
    );
    view.rerender(
      <>
        <ClaimSummary {...props} state={{ ...complete }} />
        <ClaimProgress {...props} state={{ ...complete }} />
      </>,
    );
    const current = document.querySelector('[aria-current="step"]');
    if (!(current instanceof HTMLElement)) throw new Error("Missing unsettled step");
    const row = within(current);
    expect(row.getByText(stepDetails[step].title)).toBeDefined();
    expect(row.getByText(stepDetails[step].function)).toBeDefined();
    expect(
      row.getByText(
        status === "failed" ? "Failed" : "Sent (waiting for the next block, about a minute)",
      ),
    ).toBeDefined();
    expect(row.queryByText("Skipped")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      `Claiming alice.qrl: 4 of 5 steps done, ${status === "failed" ? "step failed" : "waiting for the network"}.`,
    );
    if (status === "failed") expect(row.getByText("Transaction reverted")).toBeDefined();

    const confirmed: TransactionUpdate = { ...update, status: "confirmed" };
    delete confirmed.message;
    view.rerender(
      <>
        <ClaimSummary {...props} running={false} updates={[confirmed]} />
        <ClaimProgress {...props} running={false} updates={[confirmed]} />
      </>,
    );
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
    expect(row.getByText("Done")).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe(
      "alice.qrl is ready. It resolves to your address and is your primary name.",
    );
  },
);

const outcomes = {
  verifying: {
    status: "verifying",
    label: "Mined, checking name records",
    next: "checking name records",
    recovery: true,
  },
  approval: {
    status: "approval",
    label: "Approve in your wallet now",
    next: "approve in your wallet now",
    recovery: true,
  },
  pending: {
    status: "pending",
    label: "Sent (waiting for the next block, about a minute)",
    next: "waiting for the network",
    recovery: true,
  },
  confirmed: {
    status: "confirmed",
    label: "Done",
    next: "preparing the next step",
    recovery: false,
  },
  skipped: {
    status: "skipped",
    label: "Skipped",
    next: "preparing the next step",
    recovery: false,
  },
  failed: { status: "failed", label: "Failed", next: "step failed", recovery: false },
  mismatched: {
    status: "mismatched",
    label: "Transaction does not match",
    next: "transaction does not match; choose a recovery option",
    recovery: true,
  },
  unconfirmed: {
    status: "unconfirmed",
    label: "Sent (waiting for the next block, about a minute)",
    next: "waiting for the network",
    recovery: true,
  },
  replaced: {
    status: "replaced",
    label: "Needs attention: transaction replaced or cancelled",
    next: "transaction replaced or cancelled; choose a recovery option",
    recovery: true,
  },
  incomplete: {
    status: "incomplete",
    label: "Needs attention: name records changed",
    next: "name records changed; choose a recovery option",
    recovery: true,
  },
  "verification-failed": {
    status: "verification-failed",
    label: "Needs attention: could not verify name records",
    next: "could not verify name records; choose a recovery option",
    recovery: true,
  },
} satisfies {
  [Status in TransactionStatus]: { status: Status; label: string; next: string; recovery: boolean };
};

it.each(
  Object.values(outcomes).flatMap((outcome) => [false, true].map((hash) => ({ ...outcome, hash }))),
)(
  "explicitly presents $status with hash=$hash and its recovery policy",
  ({ status, label, next, recovery, hash }) => {
    const update: TransactionUpdate = {
      step: "register",
      status,
      ...(hash ? { hash: `0x${"d".repeat(64)}` } : {}),
    };
    const props = {
      name: "alice.qrl",
      config,
      primary: false,
      state: null,
      updates: [update],
      running: true,
    };
    render(
      <>
        <ClaimSummary {...props} />
        <ClaimProgress {...props} />
      </>,
    );
    const first = screen.getAllByRole("listitem")[0];
    if (!first) throw new Error("Missing first step");
    expect(
      within(first).getByText(status === "unconfirmed" && !hash ? "Waiting" : label, {
        selector: "dd",
      }),
    ).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain(
      status === "unconfirmed" && !hash ? "check your wallet activity" : next,
    );
    expect(transactionOutcomes[status].recovery).toBe(recovery);
  },
);

it("keeps future required rows waiting when a running plan receives a complete snapshot", async () => {
  const chain = new MockChain();
  const name = registrationName("alice");
  chain.seed(name.name, ACCOUNT);
  chain.resolvers.set(name.node, config.contracts.QRLPublicResolver ?? "");
  const initial = await readRegistrationState(name.name, ACCOUNT, { config, provider: chain });
  const plan = registrationPlan(initial, true);
  chain.addresses.set(name.node, ACCOUNT);
  chain.spellings.set(name.node, name.name);
  chain.primary = name.name;
  chain.resolvers.set(reverseNodeFor(ACCOUNT), config.contracts.QRLPublicResolver ?? "");
  const complete = await readRegistrationState(name.name, ACCOUNT, { config, provider: chain });
  const props = {
    name: name.name,
    config,
    primary: true,
    plan,
    state: complete,
    running: true,
    updates: [{ step: "address", status: "approval" }] satisfies TransactionUpdate[],
  };
  render(
    <>
      <ClaimSummary {...props} />
      <ClaimProgress {...props} />
    </>,
  );
  const list = within(screen.getByRole("list", { name: "Claim steps" }));
  expect(list.getAllByText("Skipped", { selector: "dd" })).toHaveLength(2);
  expect(list.getAllByText("Waiting", { selector: "dd" })).toHaveLength(2);
  expect(list.getByText("Approve in your wallet now", { selector: "dd" })).toBeDefined();
  expect(screen.getByRole("status").textContent).toBe(
    "Claiming alice.qrl: 2 of 5 steps done, approve in your wallet now.",
  );
});
