export interface AndroidRelease {
  version: string;
  build: number;
  size: number;
  sha256: string;
  certificate: string;
  publishedAt: string;
  notes: string;
}

export function validRelease(value: unknown): value is AndroidRelease {
  const r = value as AndroidRelease | null;
  return (
    !!r &&
    typeof r.version === 'string' &&
    /^\d+\.\d+\.\d+$/.test(r.version) &&
    Number.isSafeInteger(r.build) &&
    r.build > 0 &&
    Number.isSafeInteger(r.size) &&
    r.size > 0 &&
    r.size <= 200 * 1024 * 1024 &&
    /^[a-f0-9]{64}$/.test(r.sha256) &&
    /^[a-f0-9]{64}$/.test(r.certificate) &&
    typeof r.notes === 'string' &&
    r.notes.length <= 8000 &&
    typeof r.publishedAt === 'string' &&
    Number.isFinite(Date.parse(r.publishedAt))
  );
}

export const releasePath = (r: AndroidRelease) =>
  `/api/app/android-release/${r.build}/${r.sha256}.apk`;
