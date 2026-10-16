/**
 * Official platform connectors. Import from "@/lib/connectors".
 *
 *   CONNECTORS                          { instagram, tiktok }: one Connector per platform
 *   getConnector(platform)              Connector for a URL segment / DB value, or null when unknown
 *   isConnectorPlatform(value)          type guard for "instagram" | "tiktok"
 *   connectorStatus(env?)               which connectors have their env vars (for the "Connect" buttons)
 *   instagramConnector, tiktokConnector the individual connectors
 *   ConnectorError, isConnectorError    the error class every connector throws
 *
 * LinkedIn has no connector on purpose: see docs/CONNECTORS.md (it stays on export/import).
 */
import { instagramConnector } from "./instagram";
import { tiktokConnector } from "./tiktok";
import { missingEnv, type Connector, type ConnectorEnv, type ConnectorPlatform } from "./types";

export { instagramConnector, INSTAGRAM_GRAPH_VERSION, INSTAGRAM_OPTIONAL_SCOPES, INSTAGRAM_SCOPES } from "./instagram";
export { tiktokConnector, TIKTOK_API_VERSION, TIKTOK_OPTIONAL_SCOPES, TIKTOK_SCOPES } from "./tiktok";
export { ConnectorError, isConnectorError, missingEnv } from "./types";
export type {
  Connector,
  ConnectorEnv,
  ConnectorErrorInit,
  ConnectorPlatform,
  FetchLike,
  NormalizedPost,
  TokenSet,
} from "./types";

export const CONNECTORS: Readonly<Record<ConnectorPlatform, Connector>> = {
  instagram: instagramConnector,
  tiktok: tiktokConnector,
};

export const CONNECTOR_PLATFORMS: readonly ConnectorPlatform[] = ["instagram", "tiktok"];

export function isConnectorPlatform(value: string): value is ConnectorPlatform {
  return (CONNECTOR_PLATFORMS as readonly string[]).includes(value);
}

/** The connector for `platform`, or null when the platform has no official connector. */
export function getConnector(platform: string): Connector | null {
  return isConnectorPlatform(platform) ? CONNECTORS[platform] : null;
}

export type ConnectorStatus = {
  platform: ConnectorPlatform;
  label: string;
  configured: boolean;
  /** Env var names still unset or blank, for the "not configured" hint. */
  missingEnv: string[];
};

export function connectorStatus(env: ConnectorEnv = process.env): ConnectorStatus[] {
  return CONNECTOR_PLATFORMS.map((platform) => {
    const connector = CONNECTORS[platform];
    const missing = missingEnv(connector.requiredEnv, env);
    return { platform, label: connector.label, configured: missing.length === 0, missingEnv: missing };
  });
}
