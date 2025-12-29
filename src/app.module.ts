import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SchedulerModule } from './scheduler/scheduler.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const dbType = config.get<string>('DB_TYPE', 'sqlite');
        const entities = [__dirname + '/**/*.entity{.ts,.js}'];

        if (dbType === 'mysql') {
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
        }

        return {
          type: 'sqlite' as const,
          database: config.get<string>('DB_FILE', 'database.sqlite'),
          entities,
          synchronize: true,
          logging: false,
        };
      },
    }),
    SchedulerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
