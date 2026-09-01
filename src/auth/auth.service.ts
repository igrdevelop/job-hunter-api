import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { MailService } from '../mail/mail.service';
import { UserPathsService } from '../users/user-paths.service';
import { User, UsersRepository } from './user.db';

const BCRYPT_ROUNDS = 12;
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly userPaths: UserPathsService,
  ) {}

  async onModuleInit() {
    if (this.users.count() > 0) {
      return;
    }
    const email = this.config.get<string>('seed.email');
    const password = this.config.get<string>('seed.password');
    if (!email || !password) {
      return;
    }
    await this.registerOwner(email, password);
    this.logger.log(`Seeded owner account: ${email}`);
  }

  async register(email: string, password: string): Promise<{ id: string; email: string }> {
    if (!this.config.get<boolean>('app.registrationEnabled')) {
      throw new ForbiddenException('Registration is disabled');
    }
    if (this.users.findByEmail(email)) {
      throw new ConflictException('Email already registered');
    }
    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = this.users.create(email, hashed);
    this.userPaths.ensureUserDirs(user.id);
    await this.sendVerificationEmail(user);
    return { id: user.id, email: user.email };
  }

  async registerOwner(email: string, password: string): Promise<{ id: string; email: string }> {
    if (this.users.findByEmail(email)) {
      throw new ConflictException('Email already registered');
    }
    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = this.users.createAdmin(email, hashed);
    this.userPaths.ensureUserDirs(user.id);
    return { id: user.id, email: user.email };
  }

  async login(email: string, password: string): Promise<{ accessToken: string }> {
    const user = await this.validateUser(email, password);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.disabled) {
      throw new ForbiddenException('Account is disabled');
    }
    const accessToken = this.jwtService.sign({ sub: user.id, email: user.email, role: user.role });
    return { accessToken };
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = this.users.consumeVerificationToken(token);
    if (!userId) {
      throw new ForbiddenException('Invalid or expired verification token');
    }
    this.users.setEmailVerified(userId);
  }

  async resendVerification(email: string): Promise<void> {
    const user = this.users.findByEmail(email);
    if (!user || user.email_verified) {
      // Silently succeed — don't leak whether an email exists or is verified.
      return;
    }
    this.users.deleteVerificationTokensByUser(user.id);
    await this.sendVerificationEmail(user);
  }

  async validateUser(email: string, password: string): Promise<User | null> {
    const user = this.users.findByEmail(email);
    if (!user) {
      return null;
    }
    const matches = await bcrypt.compare(password, user.password);
    return matches ? user : null;
  }

  findById(id: string): User | null {
    return this.users.findById(id) ?? null;
  }

  /**
   * docs/PROFILE_PAGE_TABS.md T3 (revised 2026-09-01): gates the owner-only
   * site UI (the Rendered Files tab + the variant chip row). Derived from
   * `role='admin'` — the original T3 shipped a configured `OWNER_USER_ID`
   * instead, but the deploy workflow is the sole writer of both the compose
   * file AND `.env` on the VPS, so the hand-added variable was silently
   * wiped on the very next deploy and the owner lost the owner-only tabs
   * (live incident, 2026-09-01). A DB-backed role cannot be un-deployed.
   * `OWNER_USER_ID` remains honored as an optional narrowing override for a
   * hypothetical multi-admin deployment where only one admin is "the owner".
   */
  isOwner(userId: string): boolean {
    const ownerId = this.config.get<string>('owner.userId');
    if (ownerId) {
      return userId === ownerId;
    }
    const user = this.users.findById(userId);
    return user?.role === 'admin';
  }

  private async sendVerificationEmail(user: User): Promise<void> {
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);
    this.users.createVerificationToken(user.id, token, expiresAt);
    await this.mail.sendVerification(user.email, token);
  }
}
