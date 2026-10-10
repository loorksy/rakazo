/** Audited public read destinations. Neither model hints nor MCP readOnlyHint adds a grant. */
export const FINANCIAL_RESEARCH_ORIGINS = [
  "https://en.wikipedia.org",
  "https://www.wikipedia.org",
  "https://www.google.com",
  "https://www.bing.com",
  "https://www.reuters.com",
  "https://www.ft.com",
  "https://github.com",
  "https://raw.githubusercontent.com",
  "https://registry.npmjs.org",
  "https://pypi.org",
  "https://files.pythonhosted.org",
] as const;
const origins = new Set<string>(FINANCIAL_RESEARCH_ORIGINS);
export function financialResearchUrlAllowed(raw: string, method = "GET") {
  try {
    const url = new URL(raw);
    return (
      ["GET", "HEAD"].includes(method) && !url.username && !url.password && origins.has(url.origin)
    );
  } catch {
    return false;
  }
}
