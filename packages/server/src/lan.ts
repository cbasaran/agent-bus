import { networkInterfaces } from "node:os";

export interface ResolvedLanAddresses {
  lanUrls: string[];
  localUrl: string;
}

function isPrivateLanIpv4(ip: string): boolean {
  if (ip.startsWith("192.168.") || ip.startsWith("10.")) {
    return true;
  }
  if (ip.startsWith("172.")) {
    const second = Number(ip.split(".")[1]);
    return Number.isInteger(second) && second >= 16 && second <= 31;
  }
  return false;
}

function formatHostForUrl(ipOrHost: string): string {
  if (ipOrHost.includes(":") && !ipOrHost.startsWith("[")) {
    return `[${ipOrHost}]`;
  }
  return ipOrHost;
}

export function resolveLanAddresses(port: number, host = "0.0.0.0"): ResolvedLanAddresses {
  const trimmedHost = host.trim() || "0.0.0.0";
  const isWildcard = trimmedHost === "0.0.0.0" || trimmedHost === "::";
  const isLoopback =
    trimmedHost === "127.0.0.1" || trimmedHost === "localhost" || trimmedHost === "::1";

  const discoveredIpv4: string[] = [];

  if (isWildcard) {
    const nets = networkInterfaces();
    for (const entries of Object.values(nets)) {
      if (!entries) continue;
      for (const net of entries) {
        const family = String(net.family);
        if ((family === "IPv4" || family === "4") && !net.internal && net.address) {
          if (!discoveredIpv4.includes(net.address)) {
            discoveredIpv4.push(net.address);
          }
        }
      }
    }
    discoveredIpv4.sort((a, b) => {
      const aPriv = isPrivateLanIpv4(a) ? 0 : 1;
      const bPriv = isPrivateLanIpv4(b) ? 0 : 1;
      if (aPriv !== bPriv) return aPriv - bPriv;
      return a.localeCompare(b);
    });
  }

  const addresses: string[] = [];
  if (isWildcard) {
    for (const ip of discoveredIpv4) {
      addresses.push(ip);
    }
    if (!addresses.includes("127.0.0.1")) {
      addresses.push("127.0.0.1");
    }
  } else if (isLoopback) {
    addresses.push("127.0.0.1");
  } else {
    addresses.push(trimmedHost);
    if (!addresses.includes("127.0.0.1")) {
      addresses.push("127.0.0.1");
    }
  }

  const lanUrls = addresses.map((addr) => `http://${formatHostForUrl(addr)}:${port}`);

  const connectHost = isWildcard || isLoopback ? "127.0.0.1" : formatHostForUrl(trimmedHost);
  const localUrl = `http://${connectHost}:${port}`;

  return { lanUrls, localUrl };
}
