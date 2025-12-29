import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobEntity } from './entities/job.entity';
import axios, { AxiosRequestConfig } from 'axios';
import * as cron from 'node-cron';

@Injectable()
export class JobRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobRunnerService.name);

  // track active timers / cron jobs so we can clean up on shutdown
  private timers = new Map<string, NodeJS.Timeout>();
  private cronJobs = new Map<string, cron.ScheduledTask>();

  private concurrency = 5;
  private running = 0;
  private queue: (() => void)[] = [];

  // track metadata about scheduled cron tasks so we can detect updates
  private cronMeta = new Map<string, { cron: string; timezone?: string }>();

  // periodic DB sync interval
  private syncInterval?: NodeJS.Timeout;
  private readonly SYNC_MS = parseInt(process.env.JOB_SYNC_INTERVAL_MS ?? '300000', 10); // 5 minutes by default


  constructor(
    @InjectRepository(JobEntity)
    private readonly repo: Repository<JobEntity>,
  ) {}

  async onModuleInit() {
    this.logger.log('JobRunner starting — scanning for scheduled jobs');
    // load scheduled jobs and schedule them
    const jobs = await this.repo.find();
    for (const job of jobs) {
      if (job.type === 'oneoff') {
        await this.scheduleOneOff(job);
      } else if (job.type === 'recurring') {
        await this.scheduleRecurring(job);
      }
    }

    // start periodic DB sync to pick up changes (additions, updates, deletions)
    this.syncWithDb().catch((err) => this.logger.error('Initial sync failed', err as any));
    this.syncInterval = setInterval(() => {
      this.syncWithDb().catch((err) => this.logger.error('Periodic sync failed', err as any));
    }, this.SYNC_MS);
  }

  onModuleDestroy() {
    this.logger.log('Stopping JobRunner, clearing timers');
    if (this.syncInterval) clearInterval(this.syncInterval);
    this.timers.forEach((t) => clearTimeout(t));
    this.cronJobs.forEach((c) => c.stop());
  }

  private async scheduleOneOff(job: JobEntity) {
    try {
      if (!job.scheduling?.execute_at) {
        this.logger.warn(`Oneoff job ${job.id} missing execute_at`);
        return;
      }

      // If we already have a timer for this job, skip scheduling
      if (this.timers.has(job.id)) {
        this.logger.log(`Oneoff ${job.id} already scheduled`);
        return;
      }

      const runAt = new Date(job.scheduling.execute_at).getTime();
      const now = Date.now();

      if (runAt <= now && job.status === 'scheduled') {
        // run immediately
        this.enqueue(() => this.execute(job.id));
        return;
      }

      const delay = Math.max(0, runAt - now);
      // Node setTimeout cannot handle delays > 2^31-1 (about 24.8 days)
      const MAX_TIMEOUT = 2147483647;

      if (delay > MAX_TIMEOUT) {
        // schedule a shorter timer to re-evaluate closer to the run time
        const t = setTimeout(() => {
          this.timers.delete(job.id);
          // reschedule again (recursive) — this avoids overflow
          this.scheduleOneOff(job);
        }, Math.min(delay, MAX_TIMEOUT));
        this.timers.set(job.id, t);
        this.logger.log(`Oneoff ${job.id} scheduled re-check in ${Math.min(delay, MAX_TIMEOUT)}ms (too far in future)`);
      } else {
        const t = setTimeout(() => {
          this.timers.delete(job.id);
          this.enqueue(() => this.execute(job.id));
        }, delay);
        this.timers.set(job.id, t);
        this.logger.log(`Scheduled oneoff ${job.id} to run in ${delay}ms`);
      }
      // already scheduled inside the chosen branch above
    } catch (err) {
      this.logger.error('Error scheduling oneoff', err as any);
    }
  }

  private async scheduleRecurring(job: JobEntity) {
    try {
      const cronExpr = job.scheduling?.cron;
      if (!cronExpr) {
        this.logger.warn(`Recurring job ${job.id} missing cron`);
        return;
      }

      const timezone = job.scheduling?.timezone;
      const options = timezone ? { timezone } : undefined;

      // If we already have a cron for this id, remove it first (handles updates)
      if (this.cronJobs.has(job.id)) {
        await this.unscheduleJob(job.id);
      }

      const task = cron.schedule(cronExpr, () => {
        this.enqueue(() => this.execute(job.id));
      }, options as any);

      this.cronJobs.set(job.id, task);
      this.cronMeta.set(job.id, { cron: cronExpr, timezone: timezone });
      this.logger.log(`Scheduled recurring ${job.id} cron=${cronExpr} tz=${timezone}`);
    } catch (err) {
      this.logger.error('Error scheduling recurring', err as any);
    }
  }

  private enqueue(fn: () => void) {
    if (this.running < this.concurrency) {
      this.running++;
      // run immediately
      Promise.resolve()
        .then(fn)
        .catch((err) => this.logger.error('Queue exec error', err))
        .finally(() => this._taskDone());
    } else {
      this.queue.push(fn);
    }
  }

  private _taskDone() {
    this.running = Math.max(0, this.running - 1);
    const next = this.queue.shift();
    if (next) {
      this.running++;
      Promise.resolve()
        .then(next)
        .catch((err) => this.logger.error('Queue exec error', err))
        .finally(() => this._taskDone());
    }
  }

  async execute(id: string) {
    const job = await this.repo.findOneBy({ id });
    if (!job) return;
    if (job.status === 'running') return;

    job.status = 'running';
    job.attempt_count = (job.attempt_count || 0) + 1;
    await this.repo.save(job);

    this.logger.log(`Executing job ${job.id} attempt ${job.attempt_count}`);

    const cfg: AxiosRequestConfig = {
      url: job.target_url,
      method: job.target_method as any,
      headers: job.headers ?? {},
      params: job.params ?? {},
      data: job.payload ?? job.body ?? undefined,
      timeout: 30000,
      validateStatus: () => true, // we'll handle statuses ourselves
    };

    let responseStatus = 0;
    let responseData: any = null;
    let errorMessage: string | null = null;

    try {
      const res = await axios(cfg);
      responseStatus = res.status;
      responseData = res.data;
    } catch (err: any) {
      errorMessage = String(err?.message ?? err);
      this.logger.warn(`Job ${job.id} HTTP request failed: ${errorMessage}`);
    }

    const success = responseStatus > 0 && responseStatus < 400;

    if (success) {
      // success handling
      job.last_error = null;

      if (job.type === 'oneoff') {
        // mark one-off jobs as completed
        job.status = 'completed';
        await this.repo.save(job);
        
        // ensure any timers/cron are cleaned up
        await this.unscheduleJob(job.id);
      } else {
        job.status = 'scheduled';
        job.attempt_count = 0; // reset attempts for recurring
        await this.repo.save(job);
      }
      

      this.logger.log(`Job ${job.id} succeeded with status=${responseStatus}`);
      return;
    }

    // failure
    job.last_error = errorMessage ?? `status:${responseStatus}`;
    await this.repo.save(job);

    const retries = job.retries ?? {};
    const enabled = retries.enabled ?? false;
    const maxAttempts = retries.max_attempts ?? 0;
    const retryable = retries.retryable_statuses ?? [];

    const isRetryable = errorMessage !== null || retryable.includes(responseStatus);

    if (enabled && job.attempt_count < (maxAttempts || 0) && isRetryable) {
      // schedule retry with backoff
      const attempt = job.attempt_count;
      const base = 1000; // ms
      const backoff = Math.pow(2, attempt) * base;
      const jitter = Math.floor(Math.random() * base);
      const delay = backoff + jitter;

      this.logger.log(`Retrying job ${job.id} in ${delay}ms (attempt ${attempt})`);

      const t = setTimeout(() => {
        this.timers.delete(job.id + ':retry:' + attempt);
        this.enqueue(() => this.execute(job.id));
      }, delay);
      this.timers.set(job.id + ':retry:' + attempt, t);
      return;
    }

    // no more retries, mark failed
    job.status = 'failed';
    await this.repo.save(job);
    this.logger.warn(`Job ${job.id} failed permanently after ${job.attempt_count} attempts`);
  }

  // allow external creation to ask runner to schedule a created job
  async scheduleNewJob(job: JobEntity) {
    if (job.type === 'oneoff') return this.scheduleOneOff(job);
    return this.scheduleRecurring(job);
  }

  // sync DB and ensure runner state reflects DB state
  async syncWithDb() {
    this.logger.log('Syncing jobs from DB');
    const jobs = await this.repo.find();
    const dbIds = new Set(jobs.map((j) => j.id));

    // unschedule recurrences that were removed from DB
    for (const id of Array.from(this.cronJobs.keys())) {
      if (!dbIds.has(id)) {
        this.logger.log(`Recurring job ${id} missing in DB — unscheduling`);
        await this.unscheduleJob(id);
      }
    }

    // schedule new/changed jobs
    for (const job of jobs) {
      if (job.type === 'recurring') {
        const cronExpr = job.scheduling?.cron;
        const tz = job.scheduling?.timezone;
        if (!cronExpr) continue;

        const meta = this.cronMeta.get(job.id);
        if (!this.cronJobs.has(job.id)) {
          await this.scheduleRecurring(job);
        } else if (!meta || meta.cron !== cronExpr || meta.timezone !== tz) {
          // updated cron expression or tz
          await this.unscheduleJob(job.id);
          await this.scheduleRecurring(job);
          this.logger.log(`Rescheduled recurring ${job.id} due to change`);
        }
      } else if (job.type === 'oneoff') {
        // schedule one-off jobs that aren't already scheduled
        if (job.status === 'scheduled' && !this.timers.has(job.id)) {
          await this.scheduleOneOff(job);
        }
      }
    }
  }

  // allow external callers to unschedule a job (clear timers / cron tasks)
  async unscheduleJob(id: string) {
    // clear main timer
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }

    // clear retry timers like `${id}:retry:${attempt}`
    for (const key of Array.from(this.timers.keys())) {
      if (key.startsWith(id + ':retry:')) {
        const rt = this.timers.get(key);
        if (rt) clearTimeout(rt);
        this.timers.delete(key);
      }
    }

    // stop cron job if present
    const task = this.cronJobs.get(id);
    if (task) {
      try {
        task.stop();
      } catch (err) {
        this.logger.warn(`Error stopping cron for ${id}: ${String(err)}`);
      }
      this.cronJobs.delete(id);
      this.cronMeta.delete(id);
    }
    this.logger.log(`Unscheduled job ${id}`);
  }

  // unschedule everything (clear timers and stop all cron jobs)
  async unscheduleAll() {
    // clear all timers
    for (const [key, t] of Array.from(this.timers.entries())) {
      try {
        clearTimeout(t);
      } catch (err) {
        this.logger.warn(`Error clearing timer ${key}: ${String(err)}`);
      }
      this.timers.delete(key);
    }

    // stop all cron jobs
    for (const [id, task] of Array.from(this.cronJobs.entries())) {
      try {
        task.stop();
      } catch (err) {
        this.logger.warn(`Error stopping cron ${id}: ${String(err)}`);
      }
      this.cronJobs.delete(id);
    }

    this.logger.log('Unscheduled all jobs');
  }
}
