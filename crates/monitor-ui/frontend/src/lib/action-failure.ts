import { ZodError } from "zod";

/**
 * Turns an action failure into one operator-readable sentence.
 *
 * `error.message` is not safe to show directly: a ZodError serializes to a JSON
 * issue array, and the Tauri secret store throws a developer-facing string. Both
 * used to reach the toast verbatim, so the console displayed payload internals
 * where a next step belongs.
 */
export const describeActionFailure = (reason: unknown): string => {
  if (reason instanceof ZodError) {
    return "the gateway returned settings this console does not understand; update the app or gateway so both speak the same schema";
  }
  const message = reason instanceof Error ? reason.message.trim() : "";
  if (message === "") return "unknown error";
  if (/secret store|keychain|secure storage/i.test(message)) {
    return "secure storage is unavailable; retry, or re-enter the key once the desktop keychain is available";
  }
  if (/^invalid api key$/i.test(message)) {
    return "the gateway rejected the API key; check the key in Settings";
  }
  return message;
};

export const actionFailed = (reason: unknown): string =>
  `Action failed: ${describeActionFailure(reason)}`;
