import { z } from 'zod';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const d = new Date(value + 'T00:00:00.000Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}, '日期无效');
export function tripDates(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let t = Date.parse(start + 'T00:00:00Z'); t <= Date.parse(end + 'T00:00:00Z') && dates.length < 15; t += 86400000) dates.push(new Date(t).toISOString().slice(0, 10));
  return dates;
}
export const tripConstraintsSchema = z.object({
  destination: z.string().trim().min(1).max(120), departure: z.string().trim().max(120).default(''),
  startDate: dateString, endDate: dateString, people: z.number().int().min(1).max(20),
  budget: z.number().finite().positive().max(100000000), currency: z.string().regex(/^[A-Z]{3}$/).default('CNY'),
  preferences: z.string().trim().max(2000).default(''), exclusions: z.string().trim().max(2000).default(''),
}).strict().refine(v => {
  const d = (Date.parse(v.endDate) - Date.parse(v.startDate)) / 86400000;
  return d >= 0 && d < 14;
}, '行程需为 1 至 14 天');
export type TripConstraints = z.infer<typeof tripConstraintsSchema>;
const text = z.string().trim().min(1).max(4000);
const safeUrl = z.string().max(2000).url().refine(v => { try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } });
export const itinerarySchema = z.object({
  title: z.string().trim().min(1).max(160), summary: text,
  days: z.array(z.object({
    date: dateString, title: z.string().min(1).max(160), summary: text,
    activities: z.array(z.object({
      time: z.string().max(80), title: z.string().min(1).max(160), description: text,
      location: z.string().max(240), transport: z.string().max(500),
      estimatedCost: z.number().finite().min(0).max(100000000), bookingNote: z.string().max(1000),
      sourceIds: z.array(z.string().max(80)).max(10),
    }).strict()).min(1).max(12),
  }).strict()).min(1).max(14),
  budget: z.array(z.object({category:z.string().min(1).max(100),amount:z.number().finite().min(0).max(100000000),note:z.string().max(1000)}).strict()).min(1).max(20),
  packing: z.array(z.string().max(400)).max(30), notes: z.array(z.string().max(2000)).max(30),
  sources: z.array(z.object({id:z.string().min(1).max(80),title:z.string().min(1).max(300),url:safeUrl,retrievedAt:z.string().datetime()}).strict()).max(20),
  verification: z.object({mode:z.enum(['not_live_verified','live_search','demo']),notice:z.string().min(1).max(2000),researchedAt:z.string().datetime().nullable()}).strict(),
}).strict();
export type Itinerary = z.infer<typeof itinerarySchema>;
export const credentialsSchema = z.object({email:z.string().trim().email().max(254).transform(s=>s.toLowerCase()),password:z.string().min(12).max(128)}).strict();
export const registerSchema = credentialsSchema.extend({inviteCode:z.string().min(20).max(128)});
export const settingsSchema = z.object({provider:z.enum(['openai','deepseek','custom']),baseUrl:z.string().max(1000).optional(),model:z.string().trim().min(1).max(120).regex(/^[\w.\-/:]+$/),apiKey:z.string().min(1).max(2000).regex(/^[^\x00-\x1f\x7f]+$/).optional()}).strict();
export const jobSchema = z.object({request:z.string().trim().max(3000).default(''),mode:z.enum(['live','demo']).default('live'),idempotencyKey:z.string().uuid()}).strict();
export const idSchema = z.string().uuid();
