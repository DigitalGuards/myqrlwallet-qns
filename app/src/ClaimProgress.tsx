import {
  requireContract,
  registrationPlan,
  registrationSteps,
  type RegistrationPlan,
  type TransactionStatus,
  type NetworkConfig,
  type RegistrationState,
  type RegistrationStep,
  type TransactionUpdate,
} from "@qns/sdk";

export const claimSteps: readonly RegistrationStep[] = registrationSteps;
export const stepDetails = {
  register: {
    title: "Claim the name",
    description: (name: string) => `Registers ${name} to your address.`,
    role: "FIFS registrar",
    contract: "FIFSQRLRegistrar",
    function: "register(label, owner)",
  },
  resolver: {
    title: "Choose where records live",
    description: () => "Tells the QNS registry which contract stores this name's records.",
    role: "QNS registry",
    contract: "QNSRegistry",
    function: "setResolver(node, resolver)",
  },
  address: {
    title: "Point the name to your address",
    description: (name: string) => `Makes ${name} resolve to your wallet address.`,
    role: "Public resolver",
    contract: "QRLPublicResolver",
    function: "setAddr(node, owner)",
  },
  name: {
    title: "Store the name text",
    description: (name: string) => `Saves the spelling ${name} so apps can show your name.`,
    role: "Public resolver",
    contract: "QRLPublicResolver",
    function: "setName(node, name)",
  },
  primary: {
    title: "Make it your primary name",
    description: (name: string) => `People who look up your address see ${name}.`,
    role: "Reverse registrar",
    contract: "ReverseRegistrar",
    function: "setName(name)",
  },
} as const;

export function setupComplete(
  state: RegistrationState | null | undefined,
  primary: boolean,
): boolean {
  return (
    state !== null &&
    state !== undefined &&
    claimSteps.every((step) => (step === "primary" && !primary) || state.complete[step])
  );
}

export function remainingApprovals(
  plan: RegistrationPlan,
  updates: readonly TransactionUpdate[] = [],
): number {
  return plan.filter(({ step, required }) => {
    const update = updates.find((item) => item.step === step);
    return (
      required &&
      (!update ||
        update.status === "approval" ||
        ((update.status === "failed" || update.status === "unconfirmed") && !update.hash))
    );
  }).length;
}

// Every SDK outcome has an explicit presentation and recovery policy.
export const transactionOutcomes = {
  approval: {
    inFlight: true,
    label: "Approve in your wallet now",
    next: "approve in your wallet now",
    recovery: true,
  },
  pending: {
    inFlight: true,
    label: "Sent (waiting for the next block, about a minute)",
    next: "waiting for the network",
    recovery: true,
  },
  verifying: {
    inFlight: false,
    label: "Mined, checking name records",
    next: "checking name records",
    recovery: true,
  },
  confirmed: { inFlight: false, label: "Done", next: "preparing the next step", recovery: false },
  skipped: { inFlight: false, label: "Skipped", next: "preparing the next step", recovery: false },
  failed: { inFlight: false, label: "Failed", next: "step failed", recovery: false },
  mismatched: {
    inFlight: false,
    label: "Transaction does not match",
    next: "transaction does not match; choose a recovery option",
    recovery: true,
  },
  unconfirmed: {
    inFlight: true,
    label: "Sent (waiting for the next block, about a minute)",
    next: "waiting for the network",
    recovery: true,
  },
  replaced: {
    inFlight: false,
    label: "Needs attention: transaction replaced or cancelled",
    next: "transaction replaced or cancelled; choose a recovery option",
    recovery: true,
  },
  incomplete: {
    inFlight: false,
    label: "Needs attention: name records changed",
    next: "name records changed; choose a recovery option",
    recovery: true,
  },
  "verification-failed": {
    inFlight: false,
    label: "Needs attention: could not verify name records",
    next: "could not verify name records; choose a recovery option",
    recovery: true,
  },
} satisfies Record<
  TransactionStatus,
  { label: string; next: string; recovery: boolean; inFlight: boolean }
>;

export function stepStatus(update: TransactionUpdate | undefined): string {
  if (!update || (update.status === "unconfirmed" && !update.hash)) return "Waiting";
  return transactionOutcomes[update.status].label;
}

/** A pending wallet outcome blocks snapshot completion across every recovery source. */
export function transactionInFlight(update: TransactionUpdate): boolean {
  return transactionOutcomes[update.status].inFlight;
}

interface ClaimProgressProps {
  name: string;
  config: NetworkConfig;
  primary: boolean;
  state: RegistrationState | null | undefined;
  plan?: RegistrationPlan;
  updates: TransactionUpdate[];
  running: boolean;
  connected?: boolean;
  searching?: boolean;
  searchError?: string | null;
}

function nextStepMessage(
  update: TransactionUpdate | undefined,
  allDone: boolean,
  running: boolean,
): string {
  if (update?.status === "unconfirmed" && !update.hash) return "check your wallet activity";
  if (update) return transactionOutcomes[update.status].next;
  if (allDone) return running ? "checking name records" : "search again to verify name records";
  return running ? "preparing the next step" : "ready to continue";
}

function progressFor({
  name,
  primary,
  state,
  plan: suppliedPlan,
  updates,
  running,
  connected = false,
  searching = false,
  searchError = null,
}: ClaimProgressProps) {
  const plan = suppliedPlan ?? (state ? registrationPlan(state, primary) : null);
  const entries =
    plan ??
    claimSteps
      .filter((step) => step !== "primary" || primary)
      .map((step) => ({ step, required: true }));
  const steps = entries.map(({ step }) => step);
  const progress = entries.map(({ step, required }) => {
    const update = updates.find((item) => item.step === step);
    return {
      step,
      update:
        (!required || (!running && state?.complete[step])) &&
        (!update || update.status === "skipped" || (update.status === "failed" && !update.hash))
          ? { ...update, step, status: "skipped" as const }
          : update,
    };
  });
  const done = progress.filter(
    ({ update }) => update?.status === "confirmed" || update?.status === "skipped",
  ).length;
  const current =
    progress.find(({ update }) => update?.status === "approval") ??
    progress.find(
      ({ update }) =>
        update && (transactionOutcomes[update.status].recovery || update.status === "failed"),
    ) ??
    progress.find(({ update }) => update?.status !== "confirmed" && update?.status !== "skipped");
  const ready =
    setupComplete(state, primary) && !running && !updates.some(transactionInFlight) && !current;
  const summary = ready
    ? `${name} is ready. It resolves to your address${state?.complete.primary ? " and is your primary name" : ""}.`
    : running || updates.length > 0
      ? `Claiming ${name}: ${done} of ${steps.length} steps done, ${nextStepMessage(current?.update, done === steps.length, running)}.`
      : plan
        ? `Set up ${name}: ${remainingApprovals(plan)} wallet approvals remaining.`
        : searchError
          ? "Check the error below and search again."
          : searching
            ? `Reading ${name}...`
            : name && !connected
              ? `Connect your wallet to see the approvals ${name} needs.`
              : "Search for a name to see the steps.";
  return { steps, progress, current, ready, summary };
}

export function ClaimSummary(props: ClaimProgressProps) {
  return (
    <p className="claim-summary" role="status">
      {progressFor(props).summary}
    </p>
  );
}

export function ClaimProgress(props: ClaimProgressProps) {
  const { name, config } = props;
  const { steps, progress, current, ready } = progressFor(props);
  return (
    <div className="claim-progress">
      <ol aria-label="Claim steps">
        {progress.map(({ step, update }, index) => {
          const detail = stepDetails[step];
          const address = requireContract(config, detail.contract);
          return (
            <li key={step} aria-current={!ready && current?.step === step ? "step" : undefined}>
              <p className="step-number">
                Step {index + 1} of {steps.length}
              </p>
              <h3>{detail.title}</h3>
              <p className="muted">{detail.description(name)}</p>
              <dl>
                <div className="detail-row">
                  <dt>Status</dt>
                  <dd>{stepStatus(update)}</dd>
                </div>
                {current?.step === step && !ready && (
                  <>
                    <div className="detail-row">
                      <dt>Contract</dt>
                      <dd>
                        {detail.role}{" "}
                        <span className="font-mono" title={address}>
                          {address.slice(0, 9)}...{address.slice(-6)}
                        </span>
                      </dd>
                    </div>
                    <div className="detail-row">
                      <dt>Function</dt>
                      <dd className="font-mono">{detail.function}</dd>
                    </div>
                  </>
                )}
              </dl>
              {current?.step === step && !ready && (
                <p className="muted">No Quanta is sent; you pay a small network fee.</p>
              )}
              {update?.hash && (
                <a
                  className="transaction-link"
                  href={`https://zondscan.com/tx/${update.hash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View transaction
                </a>
              )}
              {update?.message && <p className="muted">{update.message}</p>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
