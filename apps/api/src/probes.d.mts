export interface ProbeOutcome {
  readonly ok: boolean;
  readonly reason?: string;
}

export type NetworkProbe = (
  env?: Readonly<Record<string, string | undefined>>,
  opts?: { readonly timeoutMs?: number },
) => Promise<ProbeOutcome>;

export const realProbes: Readonly<{
  redis: NetworkProbe;
  qdrant: NetworkProbe;
}>;
