import { createRoot } from "react-dom/client";
import "@fontsource-variable/instrument-sans/index.css";
import "@fontsource-variable/sora/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./style.css";
import { App } from "./App";
import { errorMessage, httpProvider, loadConfig } from "./rpc";
import { WalletController } from "./wallet";

const element = document.getElementById("root");
if (!element) throw new Error("Missing application root");
const root = createRoot(element);
root.render(
  <main className="page">
    <p role="status">Loading QNS...</p>
  </main>,
);
void loadConfig()
  .then((config) => {
    root.render(
      <App
        config={config}
        provider={httpProvider(config.rpcUrl)}
        controller={new WalletController(config)}
      />,
    );
  })
  .catch((error: unknown) => {
    root.render(
      <main className="page">
        <h1>QNS</h1>
        <p role="alert">{errorMessage(error)}</p>
        <button
          onClick={() => {
            location.reload();
          }}
        >
          Try again
        </button>
      </main>,
    );
  });
