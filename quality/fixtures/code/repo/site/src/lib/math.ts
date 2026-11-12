// Math helpers for the fixture.
import { readFileSync } from "node:fs";

/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

export const double = (n: number): number => n * 2;

// The old helpers moved out of site/src/lib/old.ts.
// TODO: drop this note once the move lands.
export function grade(score: number, bonus?: number): string {
  let total = score + (bonus ?? 0);
  if (total > 100 && bonus) total = 100;
  for (const step of [10, 20]) {
    if (total < step) return "low";
  }
  while (total > 1000) total -= 1;
  switch (total) {
    case 1:
      return "one";
    case 2:
      return "two";
    default:
      break;
  }
  try {
    readFileSync("x");
  } catch {
    total = total || 1;
  }
  return total > 50 ? "high" : "mid";
}

// const legacy = add(1, 2);
// if (legacy > 2) {
//   console.log(legacy);
// }
