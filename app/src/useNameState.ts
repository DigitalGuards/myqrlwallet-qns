import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  assertNetwork,
  isAvailable,
  isDeployed,
  nameOwner,
  readRegistrationState,
  registrationName,
  type NetworkConfig,
  type RegistrationState,
  type RpcProvider,
} from "@qns/sdk";
import { errorMessage } from "./rpc";
import type { WalletController } from "./wallet";

export interface NameResult {
  name: string;
  node: string;
  requestId: number;
  available: boolean;
  owner: string | null;
  setup: RegistrationState | null;
}

/** All displayed ownership comes from refreshName, including recovery and wallet changes. */
export function useNameState(
  config: NetworkConfig,
  provider: RpcProvider,
  controller: WalletController,
  revision: number,
) {
  const context = useMemo(
    () => ({ config, provider, controller, revision }),
    [config, provider, controller, revision],
  );
  const active = useRef(context);
  active.current = context;
  const mounted = useRef(true);
  const request = useRef(0);
  const selected = useRef<{ input: string | null; node: string | null; requestId: number }>({
    input: null,
    node: null,
    requestId: 0,
  });
  const getSelection = useCallback(() => selected.current, []);
  const [state, setState] = useState<{
    context: typeof context;
    result: NameResult | null;
    error: string | null;
    readErrorName: string | null;
    loading: boolean;
  }>({ context, result: null, error: null, readErrorName: null, loading: false });

  // An omitted input refreshes the current selection. Old operations cannot select their old name.
  const refreshName = useCallback(
    async (input?: string | null): Promise<NameResult | null> => {
      const sameContext = () =>
        mounted.current &&
        active.current === context &&
        controller.getSnapshot().revision === revision;
      if (!sameContext()) return null;
      if (input !== undefined) {
        let node: string | null = null;
        try {
          if (input !== null) node = registrationName(input).node;
        } catch {
          // Invalid input has its own request and clears the preceding selection.
        }
        selected.current = { input, node, requestId: selected.current.requestId + 1 };
      }
      const selection = selected.current;
      const selectedInput = selection.input;
      const generation = ++request.current;
      const current = () =>
        sameContext() && selected.current === selection && generation === request.current;
      const loading = selectedInput !== null && isDeployed(config);
      setState({ context, result: null, error: null, readErrorName: null, loading });
      if (!loading) return null;
      let readingName: string | null = null;
      try {
        const { name, node } = registrationName(selectedInput);
        readingName = name;
        await assertNetwork(provider, config);
        // Availability and owner must describe the same block.
        const block = await provider.request({ method: "qrl_blockNumber" });
        if (typeof block !== "string" || !/^0x[0-9a-f]+$/i.test(block))
          throw new Error("Invalid block number");
        if (!current()) return null;
        const snapshot: RpcProvider = {
          request: (args) =>
            args.method === "qrl_blockNumber"
              ? Promise.resolve(block)
              : provider.request(
                  args.method === "qrl_call"
                    ? { ...args, params: [args.params?.[0], block] }
                    : args,
                ),
        };
        const [available, owner] = await Promise.all([
          isAvailable(name, { config, provider: snapshot }),
          nameOwner(name, { config, provider: snapshot }),
        ]);
        const account = controller.getSnapshot().account;
        const setup =
          account !== null && (owner === null || owner === account)
            ? await readRegistrationState(name, account, { config, provider: snapshot })
            : null;
        await assertNetwork(provider, config);
        if (!current()) return null;
        const result = {
          name,
          node,
          requestId: generation,
          available: available && owner === null,
          owner,
          setup,
        };
        setState({ context, result, error: null, readErrorName: null, loading: false });
        return result;
      } catch (error) {
        if (current())
          setState({
            context,
            result: null,
            error: `${readingName !== null ? "Could not refresh name availability: " : ""}${errorMessage(error)}`,
            readErrorName: readingName,
            loading: false,
          });
        return null;
      }
    },
    [config, provider, controller, revision, context],
  );

  useEffect(() => {
    mounted.current = true;
    void refreshName();
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, [refreshName]);

  const visible = state.context === context;
  return {
    search: visible ? state.result : null,
    searchError: visible ? state.error : null,
    readErrorName: visible ? state.readErrorName : null,
    searching: visible && state.loading,
    refreshName,
    getSelection,
  };
}
