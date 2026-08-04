export interface Application {
  id: string;
  date: string;
  company: string;
  title: string;
  stack: string;
  ats_status: string;
  url: string;
  folder: string;
  sent: string;
  reapplication: string;
  to_learn: string;
  cost_usd: number | null;
  ats_verdict: number | null;
}
