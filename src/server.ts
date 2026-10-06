// The Android app chooses its server; the web build always uses its own site.
export const nativeServer = import.meta.env.MODE === 'android';
export interface ServerInfo {
  host: string;
  defaultHost: string;
  // Chosen on this device, at first launch or in settings.
  configured: boolean;
}
export async function getServer(): Promise<ServerInfo> {
  return (await import('./mobile')).device.getServer();
}
// Resolves once saved; a different server restarts the app at its origin.
export async function setServer(url: string) {
  return (await import('./mobile')).device.setServer({ url });
}
// A setup token on its own, or inside the setup link printed at deployment.
export function setupTokenFrom(input: string): string {
  const value = input.trim();
  const hash = value.indexOf('#');
  return hash < 0 ? value : new URLSearchParams(value.slice(hash + 1)).get('setup') || '';
}
