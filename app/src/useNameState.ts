import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  assertNetwork,
  isAvailable,
  isDeployed,
  nameOwner,
  registrationName,
  type NetworkConfig,
  type RpcProvider,
} from "@qns/sdk";
import { errorMessage } from "./rpc";
import type { WalletController } from "./wallet";

interface NameResult {
  name: string;
  available: boolean;
  owner: string | null;
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
  const selected = useRef<string | null>(null);
  const [state, setState] = useState<{
    context: typeof context;
    result: NameResult | null;
    error: string | null;
    loading: boolean;
  }>({ context, result: null, error: null, loading: false });

  // An omitted input refreshes the current selection. Old operations cannot select their old name.
  const refreshName = useCallback(
    async (input = selected.current): Promise<NameResult | null> => {
      const sameContext = () =>
        mounted.current &&
        active.current === context &&
        controller.getSnapshot().revision === revision;
      if (!sameContext()) return null;
      selected.current = input;
      const generation = ++request.current;
      const current = () => sameContext() && generation === request.current;
      const loading = input !== null && isDeployed(config);
      setState({ context, result: null, error: null, loading });
      if (!loading) return null;
      let reading = false;
      try {
        const { name } = registrationName(input);
        reading = true;
        await assertNetwork(provider, config);
        // Availability and owner must describe the same block.
        const block = await provider.request({ method: "qrl_blockNumber" });
        if (typeof block !== "string" || !/^0x[0-9a-f]+$/i.test(block))
          throw new Error("Invalid block number");
        if (!current()) return null;
        const snapshot: RpcProvider = {
          request: (args) =>
            provider.request(
              args.method === "qrl_call" ? { ...args, params: [args.params?.[0], block] } : args,
            ),
        };
        const [available, owner] = await Promise.all([
          isAvailable(name, { config, provider: snapshot }),
          nameOwner(name, { config, provider: snapshot }),
        ]);
        await assertNetwork(provider, config);
        if (!current()) return null;
        const result = { name, available: available && owner === null, owner };
        setState({ context, result, error: null, loading: false });
        return result;
      } catch (error) {
        if (current())
          setState({
            context,
            result: null,
            error: `${reading ? "Could not refresh name availability: " : ""}${errorMessage(error)}`,
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
    searching: visible && state.loading,
    refreshName,
  };
}
