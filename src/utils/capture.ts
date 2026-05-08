/* TELEMETRY COMPLETELY REMOVED
This file is a no-op stub for a clean local fork of bashun-commander.
All tracking, GA4, BigQuery, clientId, etc. removed. */

export const capture = async (_event: string, _properties?: any) => { /* no-op */ };
export const capture_call_tool = async (_event: string, _properties?: any) => { /* no-op */ };
export const capture_ui_event = async (_event: string, _properties?: any) => { /* no-op */ };
export const captureRemote = async (_event: string, _properties?: any) => { /* no-op */ };

export function sanitizeError(_error: any) {
  return { message: 'sanitized' };
}
