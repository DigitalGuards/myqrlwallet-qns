import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import {
  defineQrlApprovalHint,
  QrlApprovalHint,
  QRL_APPROVAL_HINT_TAG,
} from "@qrlwallet/connect-ui/approval";
import type { ApprovalWallet } from "@qrlwallet/connect-ui/wallets";
import { approvals, currentApprovalWallet } from "./wallet";

const UNKNOWN_WALLET: ApprovalWallet = { name: "", icon: null, kind: "extension" };
const subscribe = (listener: () => void): (() => void) => approvals.subscribe(listener);
const pendingNow = (): boolean => approvals.pending();

/**
 * Names the wallet a request is waiting for, at the top right of the page.
 * <qrl-approval-hint> from @qrlwallet/connect-ui shows itself once a wallet
 * request has been open for 2.5 seconds without an answer. It only informs:
 * it never opens or raises a wallet, and clicks pass through it.
 */
export function ApprovalHint() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const elRef = useRef<QrlApprovalHint | null>(null);
  const pending = useSyncExternalStore(subscribe, pendingNow);

  useLayoutEffect(() => {
    defineQrlApprovalHint();
    const el = document.createElement(QRL_APPROVAL_HINT_TAG);
    if (!(el instanceof QrlApprovalHint)) return undefined;
    hostRef.current?.append(el);
    elRef.current = el;
    return () => {
      el.remove();
      elRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    // The wallet is set before the request is counted, so it is current here.
    if (pending) el.wallet = currentApprovalWallet() ?? UNKNOWN_WALLET;
    el.pending = pending;
  }, [pending]);

  return <div ref={hostRef} className="approval-hint-host" />;
}
