export const WAYS_IN = ["chat", "newsletter"] as const;

export function wayIn(name: string): boolean {
  return (WAYS_IN as readonly string[]).includes(name);
}
