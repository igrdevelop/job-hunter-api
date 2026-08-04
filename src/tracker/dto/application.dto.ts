import { ApplicationStatus } from './query.dto';

export interface Application {
  id: string;
  date: string;
  company: string;
  title: string;
  stack: string;
  atsStatus: string;
  url: string;
  folder: string;
  sent: string;
  toLearn: string;
  costUsd: number | null;
  atsVerdict: number | null;
  status: ApplicationStatus;
}
