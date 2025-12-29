# Scheduler Service

A robust job scheduling service that allows you to schedule HTTP requests to be executed either once or on a recurring schedule (cron).

## API Endpoints

### 1. Create a Job
**Endpoint:** `POST /jobs`

Create a new scheduled job. The job can be a one-time execution (`oneoff`) or a recurring task (`recurring`).

#### Payload Structure

```typescript
{
  "type": "oneoff" | "recurring",
  "target": {
    "url": "string",      
    "method": "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  },
  "headers": {},          
  "body": {},             
  "scheduling": {          
     // ... specific to type
  },
  "retries": {             
    "enabled": boolean,
    "max_attempts": number,
    "retryable_statuses": number[] 
  }
}
```

#### Example: One-off Job
Executes a request once at a specific time.

```json
{
  "type": "oneoff",
  "target": {
    "url": "https://api.example.com/webhooks/process-data",
    "method": "POST"
  },
  "body": {
    "data_id": "12345"
  },
  "scheduling": {
    "execute_at": "2023-12-31T23:59:00Z", 
    "timezone": "UTC"
  }
}
```

#### Example: Recurring Job
Executes a request repeatedly based on a cron expression.

```json
{
  "type": "recurring",
  "target": {
    "url": "https://api.example.com/reports/daily",
    "method": "GET"
  },
  "scheduling": {
    "cron": "0 0 * * *",       
    "timezone": "Asia/Kolkata",
    "start_time": "2023-01-01T00:00:00Z" 
  },
  "retries": {
    "enabled": true,
    "max_attempts": 3,
    "retryable_statuses": [500, 502, 503, 504]
  }
}
```

---

### 2. List Jobs
**Endpoint:** `GET /jobs`

Returns a list of all currently scheduled jobs with their status and details.

**Response:**
```json
[
  {
    "id": "uuid-string",
    "type": "oneoff",
    "status": "scheduled",
    "target_url": "...",
    "scheduling": { ... },
    ...
  }
]
```

---

### 3. Delete a Job
**Endpoint:** `DELETE /jobs/:id`

Removes a specific job from the scheduler.

---

### 4. Delete All Jobs
**Endpoint:** `DELETE /jobs`

Removes **all** jobs from the scheduler.
