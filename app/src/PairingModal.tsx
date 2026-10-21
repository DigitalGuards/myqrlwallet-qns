import { useEffect, useLayoutEffect, useRef } from "react";
import { defineQrlPairingModal, QrlPairingModal } from "@qrlwallet/connect-ui";
import type { WalletController } from "./wallet";

export function PairingModal({
  uri,
  status,
  wallet,
}: {
  uri: string;
  status: string;
  wallet: WalletController;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const modal = useRef<QrlPairingModal | null>(null);
  useLayoutEffect(() => {
    defineQrlPairingModal();
    const element = new QrlPairingModal();
    const reset = () => {
      void wallet.pair(true);
    };
    const cancel = () => {
      void wallet.disconnect();
    };
    element.addEventListener("qrl-new-connection", reset);
    element.addEventListener("qrl-cancel", cancel);
    host.current?.append(element);
    modal.current = element;
    return () => {
      element.removeEventListener("qrl-new-connection", reset);
      element.removeEventListener("qrl-cancel", cancel);
      element.remove();
      modal.current = null;
    };
  }, [wallet]);
  useEffect(() => {
    modal.current?.setAttribute("uri", uri);
  }, [uri]);
  useEffect(() => {
    modal.current?.setAttribute("status", status);
  }, [status]);
  return <span ref={host} />;
}
