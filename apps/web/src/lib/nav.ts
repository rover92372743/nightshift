// Navigation hook so pages can route without importing main.ts (which imports them).
let impl: (to: string) => void = (to) => (location.href = to);
export function setNavigate(fn: (to: string) => void): void {
  impl = fn;
}
export function navigate(to: string): void {
  impl(to);
}
