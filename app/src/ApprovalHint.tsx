import { useLayoutEffect, useRef } from "react";
import {
  bindApprovalHint,
  defineQrlApprovalHint,
  QrlApprovalHint,
  QRL_APPROVAL_HINT_TAG,
} from "@qrlwallet/connect-ui/approval";
import { approvals, currentApprovalWallet, subscribeApprovalWallet } from "./wallet";

/**
 * Names the wallet a request is waiting for, below the header at the top
 * right. <qrl-approval-hint> from @qrlwallet/connect-ui shows itself once a
 * wallet request has been open for 2.5 seconds without an answer. It only
 * informs: it never opens or raises a wallet, and clicks pass through it.
 */
export function ApprovalHint() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    defineQrlApprovalHint();
    const el = document.createElement(QRL_APPROVAL_HINT_TAG);
    if (!(el instanceof QrlApprovalHint)) return undefined;
    // The wallet follows every counted request, also one that starts while
    // another is still open; the element follows the count.
    const nameWallet = (): void => {
      const wallet = currentApprovalWallet();
      if (wallet) el.wallet = wallet;
    };
    nameWallet();
    const stopNaming = subscribeApprovalWallet(nameWallet);
    const unbind = bindApprovalHint(el, approvals);
    hostRef.current?.append(el);
    return () => {
      unbind();
      stopNaming();
      el.remove();
    };
  }, []);

  return <div ref={hostRef} className="approval-hint-host" />;
}
