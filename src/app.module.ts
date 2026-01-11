import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SchedulerModule } from './scheduler/scheduler.module';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeyGuard } from './guards/api-key.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const dbType = config.get<string>('DB_TYPE');
        const entities = [__dirname + '/**/*.entity{.ts,.js}'];

        if (dbType !== 'mysql') {
          throw new Error('Only MySQL database is supported. Please check DB_TYPE in .env');
        }

        return {
          type: 'mysql' as const,
          host: config.get<string>('DATABASE_HOST', 'localhost'),
          port: parseInt(config.get<string>('DATABASE_PORT', '3306'), 10),
          username: config.get<string>('DATABASE_USER', 'root'),
          password: config.get<string>('DATABASE_PASSWORD', ''),
          database: config.get<string>('DATABASE_NAME', 'scheduler'),
          entities,
          synchronize: config.get<string>('DB_SYNC', 'false') === 'true',
          logging: config.get<string>('DB_LOGGING', 'false') === 'true',
        };
      },
    }),
    SchedulerModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
})
export class AppModule { }
