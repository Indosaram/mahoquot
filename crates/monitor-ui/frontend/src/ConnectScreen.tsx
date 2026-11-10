import { useState } from "react";
import { AppShell } from "./components/layout";
import { Button, Field, Input } from "./components/ui";
import { SecretStoreError, writeDesktopSecret } from "./lib/native";
import {
  getGatewayBaseUrl,
  isRemoteOnlyShell,
  setGatewayBaseUrl,
  validateGatewayBaseUrl,
} from "./lib/storage";

export const needsGatewayConnection = (): boolean =>
  isRemoteOnlyShell() && getGatewayBaseUrl() === "";

export function ConnectScreen({ onConnected }: { readonly onConnected: () => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlError = validateGatewayBaseUrl(baseUrl);

  const connect = () => {
    const endpoint = baseUrl.trim().replace(/\/+$/, "");
    const key = managementKey.trim();
    setError(null);
    setBusy(true);
    void writeDesktopSecret(endpoint, "default", "management_key", key)
      .then(() => {
        setGatewayBaseUrl(endpoint);
        onConnected();
      })
      .catch((reason: unknown) => {
        setBusy(false);
        setError(
          reason instanceof SecretStoreError
            ? reason.message
            : "Action failed: could not store the management key",
        );
      });
  };

  return (
    <AppShell className="app mobile-connect" data-mahoquot-app="mobile-connect">
      <div className="mobile-connect-body">
        <h1>Connect to your gateway</h1>
        <p>
          This app reads usage from a gateway you already run elsewhere. Enter its address and
          management key to start.
        </p>
        <Field label="Gateway URL" hint="For example http://100.78.73.127:18801">
          <Input
            aria-label="Gateway URL"
            value={baseUrl}
            placeholder="http://100.78.73.127:18801"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </Field>
        {urlError ? <small className="field-error">{urlError}</small> : null}
        <Field label="Management key" hint="The gateway rejects usage queries without it.">
          <Input
            aria-label="Management key"
            type="password"
            value={managementKey}
            placeholder="Paste the management key"
            onChange={(event) => setManagementKey(event.target.value)}
          />
        </Field>
        {error ? <small className="field-error">{error}</small> : null}
        <Button disabled={baseUrl.trim() === "" || urlError !== null || busy} onClick={connect}>
          {busy ? "Connecting…" : "Connect"}
        </Button>
      </div>
    </AppShell>
  );
}
