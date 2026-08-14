// URL and navigation safety for browser tools.
//
// Browser tools intentionally allow local dev servers (localhost/127.0.0.1/[::1])
// because frontend verification needs them. They block everything else that is
// dangerous or non-http: file://, data:, javascript:, chrome:, devtools:, link-local
// and cloud metadata addresses.

export type UrlCheck = { ok: true } | { ok: false; reason: string };

const BLOCKED_PROTOCOLS = ["file:", "data:", "javascript:", "chrome:", "chrome-extension:", "devtools:", "about:"];

const CLOUD_METADATA_HOSTNAMES = new Set([
  "169.254.169.254", // AWS / GCP / Azure / DigitalOcean
  "metadata.google.internal", // GCP
  "metadata.azure.com", // Azure
  "100.100.100.200", // Alibaba Cloud
]);

function isLinkLocal(hostname: string): boolean {
  return (
    hostname.startsWith("169.254.") || // IPv4 link-local
    /^[fF][cdde]00:/.test(hostname.replace(/^\[|\]$/g, "")) || // IPv6 ULA (fc00::/7, includes AWS metadata v6 fd00:ec2::254)
    /^fe80:/i.test(hostname.replace(/^\[|\]$/g, "")) // IPv6 link-local
  );
}

export function checkBrowserUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `Invalid URL: ${raw}` };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    if (BLOCKED_PROTOCOLS.includes(url.protocol)) {
      return { ok: false, reason: `Protocol ${url.protocol} is not allowed. Use http or https.` };
    }
    return { ok: false, reason: `Protocol ${url.protocol} is not allowed.` };
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (CLOUD_METADATA_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: `Hostname ${hostname} is a cloud metadata endpoint and is blocked.` };
  }
  if (hostname.endsWith(".metadata.")) {
    return { ok: false, reason: `Hostname ${hostname} looks like a metadata endpoint and is blocked.` };
  }
  if (isLinkLocal(hostname)) {
    return { ok: false, reason: `Link-local / metadata-range hostname ${hostname} is blocked.` };
  }
  // localhost and loopback are explicitly ALLOWED for dev-server verification.
  return { ok: true };
}

// Headers considered sensitive — never persisted into captured network buffers.
const SENSITIVE_HEADER_RE = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token)$/i;

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_RE.test(name);
}
