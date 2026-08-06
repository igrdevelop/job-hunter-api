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
import { User, UsersRepository } from './user.db';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
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
    return { id: user.id, email: user.email };
  }

  async registerOwner(email: string, password: string): Promise<{ id: string; email: string }> {
    if (this.users.findByEmail(email)) {
      throw new ConflictException('Email already registered');
    }
    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = this.users.createAdmin(email, hashed);
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
}
