import { formatter } from "@/lib/utils";

export function sumEventCounts(values: (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

export const formatEventCount = (value: number | null) => (value === null ? "—" : formatter(value));
