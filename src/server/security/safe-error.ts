import { BaseError } from "viem";

const INFRASTRUCTURE_MESSAGE = "Couldn't complete this request. Please try again or contact support if it continues.";

/** Safe for client responses and persisted activity: never return raw SDK/RPC diagnostics. */
export function safeErrorMessage(e: unknown): string {
  if (!(e instanceof Error)) return "Something went wrong. Please try again.";
  const message = e.message;
  const configuredSecret = Object.entries(process.env).some(([key, value]) =>
    /(?:SECRET|PASSWORD|PRIVATE_KEY|API_KEY|TOKEN|DATABASE_URL|RPC)/i.test(key) && !!value && value.length >= 8 && message.includes(value));
  const diagnostic = e instanceof BaseError || e.name === "DrizzleQueryError" || e instanceof TypeError || e instanceof SyntaxError ||
    ("code" in e && typeof e.code === "string" && /^(?:[0-9A-Z]{5}|E[A-Z_]+)$/.test(e.code)) ||
    /^(?:Failed query:|query:|params:)|\b(?:https?|wss?|postgres(?:ql)?):\/\/|\b(?:Bearer\s|sk-ant-|AIza|(?:api[_ -]?key|private[_ -]?key|entity[_ -]?secret|authorization)\s*[=:])/i.test(message);
  if (configuredSecret || diagnostic) return INFRASTRUCTURE_MESSAGE;
  return message.slice(0, 500) || "Something went wrong. Please try again.";
}
