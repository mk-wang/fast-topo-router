import { helper } from "./dep.js";

export function alpha(input: string): number {
  const noise = "BODY_MARKER_ALPHA";
  return input.length + helper(noise) + helper(input);
}

export class Widget {
  render(scale: number): string {
    return `BODY_MARKER_${scale}`;
  }
}

export const beta = (count: number): string => `BODY_MARKER_${count}`;
