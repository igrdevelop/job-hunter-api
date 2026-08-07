import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;
  private readonly baseUrl: string;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('mail.host');
    this.enabled = !!host;
    this.from = this.config.get<string>('mail.from') ?? 'no-reply@job-hunter.igrflex.work';
    this.baseUrl = this.config.get<string>('mail.baseUrl') ?? 'https://job-hunter.igrflex.work';

    this.transporter = nodemailer.createTransport({
      host,
      port: this.config.get<number>('mail.port') ?? 587,
      secure: false,
      auth: {
        user: this.config.get<string>('mail.user'),
        pass: this.config.get<string>('mail.pass'),
      },
    });
  }

  async sendVerification(email: string, token: string): Promise<void> {
    const link = `${this.baseUrl}/verify?token=${token}`;
    if (!this.enabled) {
      this.logger.log(`[MAIL DISABLED] Verification link for ${email}: ${link}`);
      return;
    }
    await this.transporter.sendMail({
      from: this.from,
      to: email,
      subject: 'Verify your Job Hunter account',
      text: `Click to verify your email: ${link}\n\nLink expires in 24 hours.`,
      html: `<p>Click to verify your email:</p><p><a href="${link}">${link}</a></p><p>Link expires in 24 hours.</p>`,
    });
  }
}
