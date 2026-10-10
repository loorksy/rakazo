/**
 * Runtime attestation pins this revision. Bump it whenever the enforced research boundary
 * changes, so a gateway built with older semantics can never vouch for the current build.
 */
export const FINANCIAL_CONTAINMENT_REVISION = "financial-egress-v2";

/**
 * Broker execution APIs and web trading terminals. Agents reach brokers only through the
 * structured Trading Core. This list is defense in depth: the primary guarantees are that
 * broker credentials never enter Agent or Computer reach, and that research traffic is
 * anonymous and read-only (GET/HEAD, no credentials, cookies or request bodies).
 */
export const FINANCIAL_EXECUTION_HOST_SUFFIXES = [
  "agiliumtrade.ai",
  "agiliumlabs.cloud",
  "trade.mql5.com",
  "metatraderweb.app",
  "web.metatrader.app",
  "api-fxtrade.oanda.com",
  "api-fxpractice.oanda.com",
  "stream-fxtrade.oanda.com",
  "stream-fxpractice.oanda.com",
  "api.ig.com",
  "demo-api.ig.com",
  "api.alpaca.markets",
  "paper-api.alpaca.markets",
  "api.tradier.com",
  "sandbox.tradier.com",
  "api.schwabapi.com",
  "gateway.saxobank.com",
  "openapi.ctrader.com",
  "api.spotware.com",
  "tradovateapi.com",
  "api.ibkr.com",
] as const;

const CREDENTIAL_PARAMETER =
  /^(?:access[-_]?token|auth[-_]?token|id[-_]?token|refresh[-_]?token|session[-_]?token|token|api[-_]?key|x[-_]api[-_]key|client[-_]?secret|secret|private[-_]?key|password|passwd)$/i;
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".corp"];
const MAX_RESEARCH_URL_LENGTH = 8192;

function researchHostAllowed(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (
    !host ||
    host.startsWith("[") ||
    /^[0-9.]+$/.test(host) ||
    !host.includes(".") ||
    host === "localhost" ||
    host === "metadata.google.internal" ||
    INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  )
    return false;
  return !FINANCIAL_EXECUTION_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/**
 * Public research boundary for trading deployments: anonymous GET/HEAD to any public DNS name
 * on the scheme's default port. Callers still resolve and pin public addresses (SSRF), strip
 * credentials and cookies, and refuse request bodies; this predicate never grants authority.
 */
export function financialResearchUrlAllowed(raw: string, method = "GET") {
  if (raw.length > MAX_RESEARCH_URL_LENGTH) return false;
  try {
    const url = new URL(raw);
    const defaultPort = url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : null;
    return (
      defaultPort !== null &&
      ["GET", "HEAD"].includes(method.toUpperCase()) &&
      !url.username &&
      !url.password &&
      (url.port === "" || url.port === defaultPort) &&
      researchHostAllowed(url.hostname) &&
      ![...url.searchParams.keys()].some((key) => CREDENTIAL_PARAMETER.test(key))
    );
  } catch {
    return false;
  }
}
