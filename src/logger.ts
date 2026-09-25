export function log(event: string, fields: Record<string, unknown> = {}): void {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${formatValue(value)}`);
  console.log(parts.length > 0 ? `${event} ${parts.join(" ")}` : event);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length === 0 || /\s/.test(value) ? JSON.stringify(value) : value;
  }
  return String(value);
}