import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ConnectScreen, needsGatewayConnection } from "./ConnectScreen";
import "./styles/globals.css";

const Root = () => {
  const [connected, setConnected] = useState(() => !needsGatewayConnection());
  return connected ? <App /> : <ConnectScreen onConnected={() => setConnected(true)} />;
};

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
